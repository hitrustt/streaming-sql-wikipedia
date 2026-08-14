import type { Column, Preset } from '../lib/types';

interface PresetsProps {
  presets: Preset[];
  activeId: string | null;
  onPick: (preset: Preset) => void;
}

export function PresetRail({ presets, activeId, onPick }: PresetsProps) {
  return (
    <div className="panel panel--grow">
      <div className="panel__head">
        <span className="panel__title">Ask a question</span>
        <span className="panel__meta">{presets.length}</span>
      </div>
      <div className="hint">Click any question to run it live against the stream.</div>
      <div className="panel__body scroll-fade" role="listbox" aria-label="Example queries">
        {presets.map((preset) => (
          <button
            key={preset.id}
            className="preset"
            role="option"
            aria-selected={preset.id === activeId}
            onClick={() => onPick(preset)}
          >
            <span className="preset__label">{preset.label}</span>
            <span className="preset__desc">{preset.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

interface SchemaProps {
  columns: Column[];
}

/**
 * Reference only.
 *
 * These rows were clickable (inserting the column name into the editor), but a
 * click target that silently edits text elsewhere on the page is a confusing
 * affordance -- and most visitors are reading this to understand what the data
 * contains, not to build a query. It is a legend now, and reads as one.
 */
export function SchemaPanel({ columns }: SchemaProps) {
  return (
    <div className="panel" style={{ maxHeight: '46%' }}>
      <div className="panel__head">
        <span className="panel__title">What's in the data</span>
        <span className="panel__meta">{columns.length} fields</span>
      </div>
      <div className="hint">
        Every edit in the stream carries these details — the fields you can ask questions about.
      </div>
      <div className="panel__body scroll-fade">
        {columns.map((column) => (
          <div className="schema__row" key={column.name}>
            <span className="schema__name">{column.name}</span>
            <span className="schema__type">{column.type}</span>
            <span className="schema__doc">{column.doc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
