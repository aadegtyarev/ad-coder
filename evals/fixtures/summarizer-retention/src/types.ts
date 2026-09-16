export interface Row {
  amount: number;
}

export interface Request {
  rows?: Row[];
}

export interface Response {
  status: number;
  body: Record<string, unknown>;
}
