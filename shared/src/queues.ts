// Queue name constants shared across services
export const QUEUES = {
  INGEST: 'ingest',
  EVAL: 'eval',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
