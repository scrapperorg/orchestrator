import {Injectable} from '@nestjs/common';
import {ApiService} from "@app/common/api/api.service";
import {AiService} from "./ai/ai.service";
import {ProcessingStatus} from "@app/common/interfaces/Document";

@Injectable()
export class OrchestratorService {
  constructor(private aiService: AiService, private apiService: ApiService) {
  }

  async getNextDocument() {
    const data = await this.apiService.getDownloadedDocuments();
    const documents = data.results;
    if (documents && documents.length > 0) {
      return documents.find(document => document.processingStatus === ProcessingStatus.downloaded);
    }
    return null;
  }

  async lockDocument(documentId: string) {
    return this.apiService.lockDocument(documentId);
  }

  async getDocument(documentId: string) {
    return this.apiService.getDocument(documentId);
  }

  async updateDocument(documentId: string, data: any) {
    const payload = {
      textInterpretationPrecision: data.ocr_quality,
      processingStatus: data.status,
      postOcrContent: data.analysis?.text,
      totalParts: data.analysis?.total_parts,
      part: data.analysis?.part,
    };

    return this.apiService.updateDocument(documentId, payload);
  }
}
