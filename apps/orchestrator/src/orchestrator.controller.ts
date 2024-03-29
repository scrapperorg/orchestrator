import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service';
import { PostDownloadBodyDto } from './dtos/PostDownloadBody.dto';
import { v4 as uuidv4 } from 'uuid';
import { TrustedSourceGuard } from './guards/TrustedSource.guard';
import { ConfigService } from '@nestjs/config';
import { downloadFileAndReturnHash } from '@app/common/utils/downloadFileAndReturnHash';

@Controller()
export class OrchestratorController {
  private tempMemory = {};
  constructor(
    private orchestratorService: OrchestratorService,
    private configService: ConfigService,
  ) {}

  @UseGuards(TrustedSourceGuard)
  @Get('/health')
  async health() {
    return { status: 'ok' };
  }

  @Get('/next-document')
  async getNextDocument(@Res() res) {
    try {
      console.log('Reading next document...');
      const result = await this.orchestratorService.getNextDocument();
      if (!result) {
        console.log('No document found...');
        return res.status(HttpStatus.NOT_FOUND).json({ status: 'not_found' });
      }
      const { document, keywordsHash, keywords } = result;
      console.log('Document found...', document.id);
      await this.orchestratorService.lockDocument(document.id);
      if (!document.storagePath) {
        console.log('Document has no storage path. Downloading...');
        const downloadPath = await downloadFileAndReturnHash(
          `${this.configService.get('storage_path')}/${document.id}.pdf`,
          document.link,
        );
        console.log('Downloaded to', downloadPath);
        await this.orchestratorService.updateDocument(document.id, {
          storagePath: downloadPath,
        });
        document.storagePath = `${this.configService.get('storage_path')}/${
          document.id
        }.pdf`;
      }
      return res.status(HttpStatus.OK).json({
        ...document,
        status: document.processingStatus,
        // This replace is a hack to make the path work on the localhost
        storagePath: document.storagePath
          ? document.storagePath.replace(
              this.configService.get('storage_path'),
              '/opt/storage/',
            )
          : document.storagePath,
        keywords,
        keywordsHash,
      });
    } catch (e) {
      console.log(e);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ status: 'error', message: e.message });
    }
  }

  @Get('/document/:id')
  async getDocumentInfo(@Res() res, @Param('id') id: string) {
    try {
      const document = await this.orchestratorService.getDocument(id);
      if (!document) {
        return res.status(HttpStatus.NOT_FOUND).json({ status: 'not_found' });
      }
      return res.status(HttpStatus.OK).json({
        ...document,
        status: document.processingStatus,
        // This replace is a hack to make the path work on the localhost
        storagePath: document.storagePath
          ? document.storagePath.replace(
              this.configService.get('storage_path'),
              '/opt/storage/',
            )
          : document.storagePath,
      });
    } catch (e) {
      console.log(e);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ status: 'error', message: e.message });
    }
  }

  @Post('/ocr-updates')
  async postOcr(@Body() body: any, @Res() res) {
    if (!body.id) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ status: 'error', message: 'Missing job_id' });
    }
    // TODO: take text and quality from body and put it in update document.
    console.log(body);
    try {
      await this.orchestratorService.updateDocument(body.id, body);
      // await this.orchestratorService.postOcr(body.id);
      return res.status(HttpStatus.OK).json({ status: 'ok' });
    } catch (e) {
      console.log(e);
      return res
        .status(HttpStatus.OK)
        .json({ status: 'error', message: e.message });
    }
  }
}
