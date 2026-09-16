export interface Point {
  value: number;
}

export interface Sample {
  points?: Point[];
}

export interface Reading {
  status: number;
  body: Record<string, unknown>;
}
