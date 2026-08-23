export type WebhookRequestMethod = "GET" | "POST";

export type WebhookConfiguration = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  targetUrl: string;
  method: WebhookRequestMethod;
  bodyTemplate?: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type WebhookDeliveryStatus = "pending" | "delivering" | "succeeded" | "failed";

export type WebhookDelivery = {
  id: string;
  webhookId: string;
  webhookName: string;
  batchId: string;
  suiteName: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseStatus?: number;
  errorMessage?: string;
  createdAt: string;
  deliveredAt?: string;
  updatedAt: string;
};

export type WebhookDispatchClaim = {
  deliveryId: string;
  webhookId: string;
  webhookName: string;
  targetUrl: string;
  method: WebhookRequestMethod;
  bodyTemplate?: string;
  attemptNumber: number;
  leaseOwner: string;
  batch: {
    id: string;
    sequenceNumber: number;
    projectId: string;
    suiteId: string;
    suiteName: string;
    status: "succeeded" | "failed" | "cancelled";
    totalRuns: number;
    succeededRuns: number;
    failedRuns: number;
    cancelledRuns: number;
    createdAt: string;
    completedAt: string;
  };
};
