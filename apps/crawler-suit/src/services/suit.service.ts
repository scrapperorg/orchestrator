import {Injectable} from '@nestjs/common';
import {delay} from "@app/common/utils/delay";
import {ConfigService} from "@nestjs/config";
import {main as CDEP_crawler} from "../crawlers/cdep";
import {main as mdezvoltarii_crawler} from "../crawlers/mdezvoltarii";
import {main as meducatiei_crawler} from "../crawlers/meducatiei";
import {main as mfinante_crawler} from "../crawlers/mfinante";
import {main as mmediu_crawler} from "../crawlers/mmediu";
import {main as mtransport_crawler} from "../crawlers/mtransport";
import {main as senat_crawler} from "../crawlers/senat";
import {main as mae_crawler} from "../crawlers/mae";
import {main as mjustitiei_crawler} from "../crawlers/mjustitie";
import {main as mai_crawler} from "../crawlers/mai";
import {main as mapn_crawler} from "../crawlers/mapn";
import {main as cdeppl_crawler} from "../crawlers/cdep-pl";
import {ApiService} from "@app/common/api/api.service";
import {IDocumentOutgoingDTO, ProcessingStatus} from "@app/common/interfaces/Document";
import * as moment from 'moment';
import {v4} from 'uuid';
import {OrchestratorService} from "./orchestrator.service";
import {downloadFileAndReturnHash} from "@app/common/utils/downloadFileAndReturnHash";
import {RobotStatus} from "@app/common/interfaces/Robot";


@Injectable()
export class SuitService {
  constructor(private configService: ConfigService, private apiService: ApiService, private orchestratorService: OrchestratorService) {
  }

  async checkIfRobotExists() {
    try {
      console.log("Check if robot exists");
      const {data} = await this.apiService.getRobot(this.configService.get('scrapper_name'));
      return data;
    } catch (e) {
      const {data} = await this.apiService.createRobot(this.configService.get('scrapper_name'));
      return data;
    }
  }

  async run() {
    const robot_name = this.configService.get('scrapper_name');
    if (!robot_name) {
      throw new Error("No scrapper name provided. Please set the SCRAPPER_NAME environment variable.");
    }
    const robot = await this.checkIfRobotExists();
    try {
      const result = await this.chooseAndRunCrawler();
      const nameOfLastDocument = robot_name === 'camera_deputatilor_pl' ? await this.postScrapingCDEP(result) : await this.postScrapping(result);
      await this.apiService.updateRobot(robot.id, {
        status: RobotStatus.FUNCTIONAL,
        info: nameOfLastDocument ? `Robotul a rulat cu success. Ultimul document descarcat: ${nameOfLastDocument}` : 'Nu sunt fisiere noi de analizat.',
      });
    } catch (e) {
      console.log(e);
      const urlRegex = /(https?:\/\/[^\s]+)/;
      const url = e.message.match(urlRegex)[1];
      await this.apiService.updateRobot(robot.id, {
        status: RobotStatus.NOT_FUNCTIONAL,
        info: `Portalul nu este disponibil. ${url ? `Ultimul link incercat: ${url}` : e.message}`,
      });
    }
    await delay(this.configService.get('delay_between_runs'));
    await this.run();
  }

  async chooseAndRunCrawler() {
    switch (this.configService.get('scrapper_name')) {
      case 'camera_deputatilor':
        return await CDEP_crawler({timestamp: Date.now()});
      case 'senat':
        return await senat_crawler({});
      case 'mdezvoltarii':
        return await mdezvoltarii_crawler({});
      case 'meducatiei':
        return await meducatiei_crawler({});
      case 'mfinante':
        return await mfinante_crawler({});
      case 'mmediu':
        return await mmediu_crawler({});
      case 'mtransport':
        return await mtransport_crawler({});
      case 'mae':
        return await mae_crawler({});
      case 'mjustitie':
        return await mjustitiei_crawler({});
      case 'mai':
        return await mai_crawler({});
      case 'mapn':
        return await mapn_crawler({});
      case 'camera_deputatilor_pl':
        return await cdeppl_crawler({});
      default:
        return;
    }
  }

  async postScrapingCDEP(results) {
    let lastDownloadedDocument = '';
    for (const project of results[this.configService.get('scrapper_name')]) {
      let projectExists = await this.apiService.findProjectBy({title: project.name});
      const documents = project.fields.find(field => field.name === 'documents').value;
      if (!projectExists || !projectExists[0]) {
        console.log('Create project', project.name);
        const fields = await this.getFieldsForCDEPProject(project);
        const {data: remoteProject} = await this.apiService.createProject({
          ...fields,
          title: project.name,
        });
        lastDownloadedDocument = await this.updateDocumentsForProject(remoteProject.id, documents, [], this.configService.get('scrapper_name'));
        break;
      } else {
        console.log('Update project', project.name);
        const fields = await this.getFieldsForCDEPProject(project);
        await this.apiService.updateProject(projectExists[0].id, fields);
        lastDownloadedDocument = await this.updateDocumentsForProject(projectExists[0].id, documents, projectExists[0].documents, this.configService.get('scrapper_name'));
      }
    }
    return lastDownloadedDocument;
  }

  async postScrapping(result) {
    let lastDownloadedDocument = '';
    for (const project of result[this.configService.get('scrapper_name')]) {
      let projectExists = await this.apiService.findProjectBy({title: project.name});
      if (!projectExists || !projectExists[0]) {
        console.log('Create project', project.name);
        const {data: remoteProject} = await this.apiService.createProject({
          title: project.name,
        });
        lastDownloadedDocument = await this.updateDocumentsForProject(remoteProject.id, project.documents, [], this.configService.get('scrapper_name'));
        break;
      } else {
        lastDownloadedDocument = await this.updateDocumentsForProject(projectExists[0].id, project.documents, projectExists[0].documents, this.configService.get('scrapper_name'));
      }
    }
    return lastDownloadedDocument;
  }

  async updateDocumentsForProject(projectId: string, documents: any[], remoteDocuments: IDocumentOutgoingDTO[], source: string) {
    let lastDownloadedDocument = '';
    for (const document of documents) {
      try {
        const remoteDocument = remoteDocuments.find((doc) => {
          return doc.title === document.title && doc.link === document.link;
        });
        // check if document is pdf, otherwise skip.
        if (document.type !== 'pdf') {
          console.log('Document type', document.type, 'Skipping...');
          continue;
        }
        if (!remoteDocument && document.title) {
          try {
            const newDocument = await this.apiService.createDocument({
              identifier: v4(),
              title: document.title,
              project: projectId,
              link: document.link,
              publicationDate: document.date ? moment(document.date, 'DD-MM-YYYY').toISOString() : moment().toISOString(),
              source,
              status: 'nou',
              processingStatus: ProcessingStatus.created,
            });
            console.log('Download document...', document.link);
            try {
              await downloadFileAndReturnHash(`${this.configService.get('storage_path')}/${newDocument.id}.pdf`, document.link);
              console.log('File downloaded', document.link);
              await this.apiService.updateDocument(newDocument.id, {
                storagePath: `${this.configService.get('storage_path')}/${newDocument.id}.pdf`,
                processingStatus: ProcessingStatus.downloaded,
              })
              lastDownloadedDocument = document.title;
            } catch (e) {
              await this.apiService.updateDocument(newDocument.id, {
                processingStatus: ProcessingStatus.unable_to_download,
              })
              console.log('Cannot download document', document.link, e.message);
            }
          } catch (e) {
            console.log('Cannot create document', document.link, e.message);
          }
          break;
        }
      } catch (e: any) {
        console.log(e);
      }
    }
    return lastDownloadedDocument;
  }

  async getFieldsForCDEPProject(project) {
    const fields = {};
    for (const field of project.fields) {
      if (field.name === 'documents') {
        continue;
      }
      switch (field.name) {
        case 'Nr. înregistrare B.P.I.':
          // fields['numarInregistrareBPI'] = field.value;
          continue;
        case 'Nr. înregistrare Camera Deputatilor':
          fields['numarInregistrareGuvern'] = field.value;
          continue;
        case 'Nr. înregistrare Senat':
          fields['numarInregistrareSenat'] = field.value;
          continue;
        case 'Procedura legislativa':
          fields['proceduraLegislativa'] = field.value;
          continue;
        case 'Camera decizionala':
          fields['cameraDecizionala'] = field.value;
          continue;
        case 'Tip initiativa':
          fields['tipInitiativa'] = field.value;
          continue;
        case 'Procedura de urgenta':
          fields['esteProceduraDeUrgenta'] = field.value === 'da';
          continue;
        case 'Initiator - la data initierii':
          fields['initiator'] = field.value;
          continue;
        default:
          continue;
      }
    }
    return fields;
  }

}
