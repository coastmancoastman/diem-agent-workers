import crypto from "node:crypto";
import type { Request, Response } from "express";
import { WORKERS, type WorkerId } from "./constants.js";
import {
  InputError,
  parseClassifyTextInput,
  parseExtractJsonInput,
  parseGenerateDraftImageInput,
  parseSummarizeTextInput,
  parseTextToSpeechInput,
} from "./schema.js";

type A2AWorkerId = Exclude<WorkerId, "transcribe_audio">;

interface A2AEnvelope {
  jsonrpc: "2.0";
  id: string | number | null;
  method: "SendMessage";
  params: {
    message: {
      role: "ROLE_USER";
      messageId: string;
      contextId?: string;
      parts: Array<{ data?: unknown; mediaType?: string }>;
    };
  };
}

interface A2AJob {
  envelope: A2AEnvelope;
  workerId: A2AWorkerId;
  workerPath: string;
  input: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(res: Response, id: unknown, code: number, message: string): void {
  res.status(400).json({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
    error: {
      code,
      message,
      data: [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }],
    },
  });
}

export function parseA2ARequest(req: Request, res: Response): A2AJob | undefined {
  const version = req.header("a2a-version");
  if (version && version !== "1.0") {
    error(res, isObject(req.body) ? req.body.id : null, -32009, "A2A version not supported");
    return undefined;
  }
  if (!isObject(req.body) || req.body.jsonrpc !== "2.0") {
    error(res, isObject(req.body) ? req.body.id : null, -32600, "Request payload validation error");
    return undefined;
  }
  if (req.body.method !== "SendMessage") {
    error(res, req.body.id, -32601, "Method not found");
    return undefined;
  }
  const params = req.body.params;
  const message = isObject(params) ? params.message : undefined;
  if (
    !isObject(message) ||
    message.role !== "ROLE_USER" ||
    typeof message.messageId !== "string" ||
    !Array.isArray(message.parts)
  ) {
    error(res, req.body.id, -32602, "Invalid parameters");
    return undefined;
  }
  const dataParts = message.parts.filter(
    (part): part is Record<string, unknown> => isObject(part) && isObject(part.data),
  );
  if (dataParts.length !== 1) {
    error(res, req.body.id, -32602, "Exactly one JSON data part is required");
    return undefined;
  }
  const jobData = dataParts[0]!.data;
  if (!isObject(jobData) || typeof jobData.worker !== "string" || !("input" in jobData)) {
    error(res, req.body.id, -32602, "Data part must contain worker and input");
    return undefined;
  }
  const worker = Object.values(WORKERS).find((item) => item.id === jobData.worker);
  if (!worker || worker.id === WORKERS.transcribeAudio.id) {
    error(res, req.body.id, -32004, "Worker is not supported by the A2A adapter");
    return undefined;
  }
  try {
    const parsers: Record<A2AWorkerId, (value: unknown) => unknown> = {
      [WORKERS.extractJson.id]: parseExtractJsonInput,
      [WORKERS.classifyText.id]: parseClassifyTextInput,
      [WORKERS.summarizeText.id]: parseSummarizeTextInput,
      [WORKERS.textToSpeech.id]: parseTextToSpeechInput,
      [WORKERS.generateDraftImage.id]: parseGenerateDraftImageInput,
    };
    const input = parsers[worker.id](jobData.input);
    return {
      envelope: req.body as unknown as A2AEnvelope,
      workerId: worker.id,
      workerPath: worker.path,
      input,
    };
  } catch (cause) {
    const message = cause instanceof InputError ? cause.message : "Invalid worker input";
    error(res, req.body.id, -32602, message);
    return undefined;
  }
}

export function a2aSuccess(job: A2AJob, workerResult: unknown) {
  const taskId = crypto.randomUUID();
  const contextId = job.envelope.params.message.contextId ?? crypto.randomUUID();
  return {
    jsonrpc: "2.0",
    id: job.envelope.id,
    result: {
      task: {
        id: taskId,
        contextId,
        status: {
          state: "TASK_STATE_COMPLETED",
          timestamp: new Date().toISOString(),
        },
        artifacts: [
          {
            artifactId: crypto.randomUUID(),
            name: `${job.workerId} result`,
            parts: [{ data: workerResult, mediaType: "application/json" }],
          },
        ],
      },
    },
  };
}

export function a2aInternalError(job: A2AJob) {
  return {
    jsonrpc: "2.0",
    id: job.envelope.id,
    error: { code: -32603, message: "Internal error" },
  };
}

export type { A2AJob };
