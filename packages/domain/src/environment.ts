import type { RunBatchStatus } from "./run-batch";

export type ExecutionEnvironmentStatus = "active" | "disabled";

export type ExecutionEnvironment = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: ExecutionEnvironmentStatus;
  currentVersion: number;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionEnvironmentVariable = {
  name: string;
  value: string;
};

export type ExecutionEnvironmentVersion = {
  id: string;
  environmentId: string;
  version: number;
  variables: ExecutionEnvironmentVariable[];
  secretBindings: ExecutionEnvironmentSecretBinding[];
  createdBy: string;
  createdAt: string;
};

export type ExecutionEnvironmentSecretBinding = {
  name: string;
  secretId: string;
  secretVersionId: string;
};

export type ExecutionSecretStatus = "active" | "disabled";

export type ExecutionSecret = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: ExecutionSecretStatus;
  currentVersion: number;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionEnvironmentDetails = ExecutionEnvironment & {
  current: ExecutionEnvironmentVersion;
};

export type ExecutionEnvironmentReference = {
  batchId: string;
  environmentVersionId: string;
  suiteName: string;
  status: RunBatchStatus;
  createdAt: string;
};
