/**
 * The shape of a scenario document the studio authors and hands to the
 * hosted player. The player scores a cmi5 launch. Practice Evidence reads
 * the statements. This module does not score.
 */

export interface Level { id: string; label?: string; value: number; descriptor?: string }
export interface Criterion {
  id: string;
  title?: string;
  description?: string;
  weight?: number;
  concepts?: string[];
  activityId?: string;
  levels: Level[];
}
export interface Choice {
  id?: string;
  text: string;
  effects?: Record<string, number>;
  mood?: number;
  best?: boolean;
  note?: string;
}
export interface Stage {
  id?: string;
  goal?: string;
  hint?: string;
  line?: string;
  lines?: string[];
  evidenceFor?: string[];
  choices: Choice[];
  variant?: Stage & { when?: { moodAbove?: number } };
}
export interface Persona {
  id: string;
  name?: string;
  firstLine?: string;
  startMood?: number;
  variantOf?: string;
  endings?: string[];
  stages: Stage[];
}
export interface PassRule { minPercent?: number; requiredLevels?: Record<string, string> }
export interface ScenarioDoc {
  scenarioKey: string;
  title: string;
  learnerGoal?: string;
  situation?: string;
  source?: string;
  language?: string;
  assessmentUse?: string;
  resultAfterReview?: boolean;
  turnLimit?: number;
  rubricRef?: string;
  activity?: { name?: string; description?: string; concepts?: string[] };
  rubric: { criteria: Criterion[]; passRule?: PassRule };
  personas: Persona[];
  ui?: { moodBands?: number[]; brand?: string };
  xapi?: XapiBlock;
  [key: string]: unknown;
}
export interface XapiBlock {
  profile: string;
  profileVersion: string;
  verbs: Record<string, string>;
  activityTypes: Record<string, string>;
  extensions: Record<string, string>;
}
