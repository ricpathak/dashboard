import type { ImportOptions } from "../../src/model.ts";
export interface SourceConfig {
  id: string;
  label: string;
  type: "folder" | "sharepoint-online" | "sharepoint-rest";
  enabled?: boolean;
  path?: string;
  project?: string;
  projectFromFolder?: boolean;
  pollSeconds?: number;
  settleSeconds?: number;
  completionMarker?: string;
  include?: string[];
  driveId?: string;
  folderId?: string;
  tenantIdEnv?: string;
  clientIdEnv?: string;
  clientSecretEnv?: string;
  accessTokenEnv?: string;
  siteUrl?: string;
  folderServerRelativeUrl?: string;
}
export interface SourceEntry {
  name: string;
  size: number;
  version: string;
  modifiedAt: number;
  url?: string;
  locator: string;
}
export interface SourceReader {
  list: () => Promise<SourceEntry[]>;
  open: (entry: SourceEntry) => Promise<ReadableStream<Uint8Array>>;
  unchanged: (entries: SourceEntry[]) => Promise<boolean>;
}
export interface Bundle {
  key: string;
  files: SourceEntry[];
  marker?: SourceEntry;
  options: ImportOptions;
  url?: string;
}
export interface SourceItemStatus {
  key: string;
  status: string;
  error?: string;
  updatedAt: string;
}
export interface SourceStatus {
  id: string;
  label: string;
  type: SourceConfig["type"];
  location: string;
  enabled: boolean;
  pollSeconds: number;
  settleSeconds: number;
  scanning: boolean;
  lastScanAt?: string;
  lastError?: string;
  added: number;
  unchanged: number;
  pending: number;
  items: SourceItemStatus[];
}
