import { TaskPriority, TaskRequest, TaskSource } from '../../core/models';
import { WARD_IDS, idsOfKind, stationName } from '../../core/map-data';

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

// Options are derived from the loaded map (station kinds), so a different route_nodes.json still works.
const wards = () => WARD_IDS;
const rooms = () => [...WARD_IDS, ...idsOfKind('OR')];
const first = (ids: string[]) => ids[0] ?? '';
const second = (ids: string[]) => ids[1] ?? ids[0] ?? '';

export const TASK_TEMPLATES: Record<TaskSource, SourceTemplate> = {
  PHARMACY: {
    source: 'PHARMACY', label: 'Pharmacy', icon: '💊', blurb: 'Medication, IV bags, controlled substances',
    fromOptions: idsOfKind('PHARMACY'), toOptions: rooms(),
    fields: [
      { key: 'item', label: 'Item class', type: 'select', options: ['Medication', 'IV bags', 'Controlled substance'], default: 'Medication', isItem: true },
      { key: 'temperature', label: 'Temperature', type: 'select', options: ['Ambient', 'Cold chain'], default: 'Ambient' },
      { key: 'handover', label: 'Handover', type: 'select', options: ['Badge', 'PIN'], default: 'Badge' },
    ],
    quick: [
      { label: `STAT meds → ${stationName(first(wards()))}`, from: first(idsOfKind('PHARMACY')), to: first(wards()), priority: 'STAT', values: { item: 'Medication' } },
      { label: `Routine restock → ${stationName(second(wards()))}`, from: first(idsOfKind('PHARMACY')), to: second(wards()), priority: 'ROUTINE', values: { item: 'Medication' } },
      { label: `IV bags → ${stationName(first(idsOfKind('OR')))}`, from: first(idsOfKind('PHARMACY')), to: first(idsOfKind('OR')), priority: 'URGENT', values: { item: 'IV bags', temperature: 'Cold chain' } },
    ],
  },
  KITCHEN: {
    source: 'KITCHEN', label: 'Kitchen', icon: '🍽', blurb: 'Meal trays and beverages to the wards',
    fromOptions: idsOfKind('KITCHEN'), toOptions: wards(),
    fields: [
      { key: 'item', label: 'Delivery', type: 'select', options: ['Meal trays', 'Special diet meals', 'Beverages'], default: 'Meal trays', isItem: true },
      { key: 'temperature', label: 'Keep', type: 'select', options: ['Hot', 'Cold', 'Ambient'], default: 'Hot' },
    ],
    quick: [
      { label: `Lunch trays → ${stationName(first(wards()))}`, from: first(idsOfKind('KITCHEN')), to: first(wards()), priority: 'ROUTINE', values: { item: 'Meal trays' } },
      { label: `Special diet → ${stationName(second(wards()))}`, from: second(idsOfKind('KITCHEN')), to: second(wards()), priority: 'URGENT', values: { item: 'Special diet meals' } },
    ],
  },
  LAUNDRY: {
    source: 'LAUNDRY', label: 'Laundry', icon: '🧺', blurb: 'Clean linen and scrubs',
    fromOptions: idsOfKind('LAUNDRY'), toOptions: rooms(),
    fields: [
      { key: 'item', label: 'Content', type: 'select', options: ['Clean linen', 'Scrubs', 'Blankets'], default: 'Clean linen', isItem: true },
      { key: 'carts', label: 'Carts', type: 'number', default: 1 },
    ],
    quick: [
      { label: `Clean linen → ${stationName(first(wards()))}`, from: first(idsOfKind('LAUNDRY')), to: first(wards()), priority: 'ROUTINE', values: { item: 'Clean linen' } },
      { label: `Scrubs → ${stationName(first(idsOfKind('OR')))}`, from: second(idsOfKind('LAUNDRY')), to: first(idsOfKind('OR')), priority: 'URGENT', values: { item: 'Scrubs' } },
    ],
  },
  STORAGE: {
    source: 'STORAGE', label: 'Storage', icon: '📦', blurb: 'Medical supplies, sterile goods and equipment',
    fromOptions: idsOfKind('STORAGE'), toOptions: rooms(),
    fields: [
      { key: 'item', label: 'Content', type: 'select', options: ['Medical supplies', 'Sterile supplies', 'Equipment'], default: 'Medical supplies', isItem: true },
      { key: 'carts', label: 'Carts', type: 'number', default: 1 },
    ],
    quick: [
      { label: `Sterile supplies → ${stationName(first(idsOfKind('OR')))}`, from: first(idsOfKind('STORAGE')), to: first(idsOfKind('OR')), priority: 'URGENT', values: { item: 'Sterile supplies' } },
      { label: `Supplies → ${stationName(second(wards()))}`, from: second(idsOfKind('STORAGE')), to: second(wards()), priority: 'ROUTINE', values: { item: 'Medical supplies' } },
    ],
  },
  WARD: {
    source: 'WARD', label: 'Ward / OR', icon: '🛏', blurb: 'Linen, waste, supplies and returns',
    fromOptions: rooms(), toOptions: idsOfKind('LAUNDRY', 'WASTE', 'PHARMACY', 'STORAGE', 'CHECKIN'),
    fields: [
      { key: 'item', label: 'Request', type: 'select', options: ['Linen return', 'Waste collection', 'Supplies request', 'Equipment return'], default: 'Supplies request', isItem: true },
      { key: 'remark', label: 'Remark', type: 'text', default: '' },
    ],
    quick: [
      { label: 'Return linen', from: first(wards()), to: first(idsOfKind('LAUNDRY')), priority: 'ROUTINE', values: { item: 'Linen return' } },
      { label: 'Waste pickup', from: first(wards()), to: first(idsOfKind('WASTE')), priority: 'ROUTINE', values: { item: 'Waste collection' } },
      { label: 'Request supplies', from: first(wards()), to: first(idsOfKind('STORAGE')), priority: 'ROUTINE', values: { item: 'Supplies request' } },
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
