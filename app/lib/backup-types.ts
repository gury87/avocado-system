export type BackupRun = {
  id: number; number: number; attempt: number; status: string; conclusion: string | null;
  createdAt: string; updatedAt: string; event: string; url: string;
};
export type BackupOverview = {
  runs: BackupRun[]; lastSuccess: BackupRun | null; canStart: boolean; active: boolean;
  checkedAt: string;
  configurationMessage: string | null;
};
