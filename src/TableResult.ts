export interface TableResult {
  tablename: string;
  rlsEnabled: boolean;
  policyCount: number;
  warnings: string[];
  notes: string[];
}
