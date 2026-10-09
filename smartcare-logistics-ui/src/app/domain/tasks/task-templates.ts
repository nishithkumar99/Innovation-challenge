import { TaskPriority, TaskRequest, TaskSource } from '../../core/models';
import { WARD_IDS } from '../../core/map-data';

/** Schema-driven field configs per source (blueprint 1.6). In production these come from a config endpoint. */
export interface FieldDef {
  key: string;
  label: string;
  type: 'select' | 'number' | 'checkbox' | 'text';
  options?: string[];
  default: string | number | boolean;
  /** The field whose value becomes the task's `item`. */
  isItem?: boolean;
}
export interface QuickTemplate {
  label: string;
  from: string;
  to: string;
  priority: TaskPriority;
  values?: Record<string, string | number | boolean>;
}
export interface SourceTemplate {
  source: TaskSource;
  label: string;
  icon: string;
  blurb: string;
  fromOptions: string[];
  toOptions: string[];
  fields: FieldDef[];
  quick: QuickTemplate[];
}

export const TASK_TEMPLATES: Record<TaskSource, SourceTemplate> = {
  PHARMACY: {
    source: 'PHARMACY', label: 'Pharmacy', icon: '💊', blurb: 'Medication, IV bags, controlled substances',
    fromOptions: ['PH'], toOptions: [...WARD_IDS, 'OR'],
    fields: [
      { key: 'item', label: 'Item class', type: 'select', options: ['Medication', 'IV bags', 'Controlled substance'], default: 'Medication', isItem: true },
      { key: 'temperature', label: 'Temperature', type: 'select', options: ['Ambient', 'Cold chain'], default: 'Ambient' },
      { key: 'handover', label: 'Handover', type: 'select', options: ['Badge', 'PIN'], default: 'Badge' },
    ],
    quick: [
      { label: 'STAT meds → Ward A', from: 'PH', to: 'WA', priority: 'STAT', values: { item: 'Medication' } },
      { label: 'Routine restock → Ward B', from: 'PH', to: 'WB', priority: 'ROUTINE', values: { item: 'Medication' } },
      { label: 'IV bags → Operating Room', from: 'PH', to: 'OR', priority: 'URGENT', values: { item: 'IV bags', temperature: 'Cold chain' } },
    ],
  },
  LAB: {
    source: 'LAB', label: 'Laboratory', icon: '🧪', blurb: 'Specimens to the lab',
    fromOptions: [...WARD_IDS, 'OR'], toOptions: ['LAB'],
    fields: [
      { key: 'item', label: 'Specimen type', type: 'select', options: ['Blood specimen', 'Urine specimen', 'Tissue sample'], default: 'Blood specimen', isItem: true },
      { key: 'timeCritical', label: 'Time-critical', type: 'checkbox', default: false },
      { key: 'biohazard', label: 'Biohazard', type: 'checkbox', default: false },
    ],
    quick: [
      { label: 'STAT specimen · Ward A → Lab', from: 'WA', to: 'LAB', priority: 'STAT', values: { timeCritical: true } },
      { label: 'Batch pickup · Ward C → Lab', from: 'WC', to: 'LAB', priority: 'ROUTINE' },
    ],
  },
  CSSD: {
    source: 'CSSD', label: 'Sterile Services', icon: '🧰', blurb: 'Sterile trays and instrument sets',
    fromOptions: ['CSSD'], toOptions: ['OR', ...WARD_IDS],
    fields: [
      { key: 'item', label: 'Content', type: 'select', options: ['Sterile trays', 'Instrument sets'], default: 'Sterile trays', isItem: true },
      { key: 'carts', label: 'Carts', type: 'number', default: 1 },
      { key: 'window', label: 'Sterility window (h)', type: 'number', default: 24 },
    ],
    quick: [{ label: 'Sterile trays → OR', from: 'CSSD', to: 'OR', priority: 'URGENT' }],
  },
  WARD: {
    source: 'WARD', label: 'Ward station', icon: '🛏', blurb: 'Linen, supplies, equipment returns',
    fromOptions: WARD_IDS, toOptions: ['CSSD', 'PH', 'LAB'],
    fields: [
      { key: 'item', label: 'Request', type: 'select', options: ['Linen return', 'Supplies request', 'Equipment return', 'Meal tray'], default: 'Supplies request', isItem: true },
      { key: 'remark', label: 'Remark', type: 'text', default: '' },
    ],
    quick: [
      { label: 'Return linen', from: 'WA', to: 'CSSD', priority: 'ROUTINE', values: { item: 'Linen return' } },
      { label: 'Request supplies', from: 'WA', to: 'PH', priority: 'ROUTINE', values: { item: 'Supplies request' } },
    ],
  },
};

export const SOURCES = Object.values(TASK_TEMPLATES);

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

/** Builds a randomised, valid request for the simulator. */
export function randomRequest(source: TaskSource | 'MIXED', priority: TaskPriority | 'MIXED'): TaskRequest {
  const src = source === 'MIXED' ? pick(SOURCES).source : source;
  const t = TASK_TEMPLATES[src];
  const from = pick(t.fromOptions);
  const to = pick(t.toOptions.filter((x) => x !== from));
  const itemField = t.fields.find((f) => f.isItem);
  return {
    source: src, from, to,
    priority: priority === 'MIXED' ? pick<TaskPriority>(['ROUTINE', 'ROUTINE', 'URGENT', 'STAT']) : priority,
    item: itemField?.options ? pick(itemField.options) : 'Item',
    origin: 'SIMULATED',
  };
}
