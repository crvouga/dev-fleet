import type { CommandOutcome, InteractiveOptions } from './contracts';

export interface Choice {
  name: string;
  value: string;
  description?: string;
  checked?: boolean;
}

export interface Prompts {
  select(message: string, choices: Choice[]): Promise<string>;
  search(message: string, source: (term: string) => Choice[]): Promise<string>;
  checkbox(message: string, choices: Choice[]): Promise<string[]>;
  input(
    message: string,
    initial?: string,
    validate?: (value: string) => boolean | string
  ): Promise<string>;
  confirm(message: string): Promise<boolean>;
}

export interface Display {
  write(text: string): void;
  panel(title: string, body: string): void;
  table(headers: string[], rows: string[][]): void;
  progress(message: string): { stop(): void };
}

export interface Session {
  options: InteractiveOptions;
  prompts: Prompts;
  display: Display;
  workspace?: string;
  config?: string;
}

export interface CheckRow {
  node: string;
  id: string;
  status: string;
  summary: string;
  remedy?: string;
  command?: string;
}

export interface Execution {
  outcome: CommandOutcome;
  args: string[];
}
