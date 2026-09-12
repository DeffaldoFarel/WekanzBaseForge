import { BaseService } from './baseService.js';

export interface FunctionExecuteResponse<T = unknown> {
  result: T;
  logs: string[];
}

export class FunctionsService extends BaseService {
  /**
   * Mengeksekusi callable serverless function via HTTP
   *
   * @param name Nama function
   * @param body Payload input yang akan diterima function sebagai `req.body`
   */
  async execute<TResult = unknown, TBody = unknown>(
    name: string,
    body?: TBody
  ): Promise<FunctionExecuteResponse<TResult>> {
    return this.request<FunctionExecuteResponse<TResult>>(
      `api/p/${this.client.projectId}/functions/${encodeURIComponent(name)}/execute`,
      {
        method: 'POST',
        body: { body },
      }
    );
  }
}
