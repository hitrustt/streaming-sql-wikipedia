interface Props {
  onDismiss: () => void;
}

/**
 * The one thing a first-time visitor reads.
 *
 * Two sentences, in this order: what the data is (so the numbers mean
 * something), then what to do next (so there is an obvious first action).
 * Everything else on screen is dense on purpose; this strip is what makes the
 * density legible instead of intimidating.
 */
export function Intro({ onDismiss }: Props) {
  return (
    <div className="intro">
      <span className="intro__lead">What is this?</span>
      <span className="intro__text">
        Every edit being made across Wikimedia right now — all languages, live, <b>20–50 per
        second</b>. Views default to <b>people editing Wikipedia articles</b>, since most of the raw
        firehose is bots updating database records. <b>Click a question on the left</b> to run a live
        query, or edit the SQL yourself and hit Run.
      </span>
      <button className="btn btn--ghost intro__dismiss" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
