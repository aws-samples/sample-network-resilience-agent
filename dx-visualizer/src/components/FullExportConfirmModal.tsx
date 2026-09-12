import { useIsLight } from '../hooks/useTheme';
import { useFocusTrap } from '../hooks/useFocusTrap';

const SNAPSHOT_CONTENTS = [
  'AWS account IDs',
  'Resource IDs (VPC, TGW, DXGW, VIF, etc.)',
  'IPs and CIDR blocks',
  'Resource names, descriptions, and tags',
];

interface Props {
  onCancel: () => void;
  onConfirm: () => void;
  /**
   * Copy overrides for a second unredacted artifact. They default to the
   * snapshot wording, so the original call site is unchanged.
   *
   * The report needed its own text rather than a second modal: the two artifacts
   * differ in what they carry (a report has findings and prose, not a machine
   * -readable topology) and in what the safe alternative is — a snapshot has
   * "Sanitized" next to it in the same menu, a report is made safe by turning on
   * redact mode first, which the reader has to be told.
   */
  title?: string;
  description?: string;
  contents?: string[];
  confirmLabel?: string;
}

// Confirmation modal that gates an unsanitized export. Replaces the native
// window.confirm() so the warning matches the rest of the app's design language
// and can carry richer styling (warning chip, list of what the file will
// contain).
export function FullExportConfirmModal({
  onCancel,
  onConfirm,
  title = 'Export full data?',
  description = 'The exported file will contain real customer data and is not safe to share publicly.',
  contents = SNAPSHOT_CONTENTS,
  confirmLabel = 'Export full data',
}: Props) {
  const light = useIsLight();
  const trapRef = useFocusTrap(true, onCancel);

  // Only a click on the backdrop itself dismisses — clicks that land on the
  // dialog bubble up to here but keep `target` inside the panel, so the panel
  // needs no stopPropagation handler of its own.
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    // Backdrop is click-to-dismiss only and deliberately not focusable; the
    // focus trap already closes the dialog on Escape.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${
        light ? 'bg-slate-900/30 backdrop-blur-md' : 'bg-black/60'
      }`}
      onClick={handleBackdropClick}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="full-export-title"
        aria-describedby="full-export-desc"
        className={`rounded-2xl border p-6 w-[440px] ${
          light
            ? 'bg-[#fafbfc] border-slate-200/70 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.18)]'
            : 'bg-slate-800 border-slate-600 shadow-2xl'
        }`}
      >
        <div className="flex items-start gap-3 mb-4">
          <div
            className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
              light ? 'bg-amber-100' : 'bg-amber-500/15'
            }`}
          >
            <svg
              className={`w-5 h-5 ${light ? 'text-amber-600' : 'text-amber-400'}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="full-export-title"
              className={`text-[15px] font-semibold tracking-tight ${
                light ? 'text-slate-800' : 'text-white'
              }`}
            >
              {title}
            </h2>
            <p
              id="full-export-desc"
              className={`text-[12px] mt-1 leading-relaxed ${
                light ? 'text-slate-600' : 'text-slate-400'
              }`}
            >
              {description}
            </p>
          </div>
        </div>

        <div
          className={`rounded-lg p-3 mb-5 text-[11px] leading-relaxed ${
            light ? 'bg-slate-100/70 text-slate-600' : 'bg-slate-900/40 text-slate-400'
          }`}
        >
          <div className={`font-semibold mb-1.5 ${light ? 'text-slate-700' : 'text-slate-300'}`}>
            File will include:
          </div>
          <ul className="space-y-0.5 ml-3.5 list-disc">
            {contents.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="mt-2 italic">
            Only continue if you trust where the file is going.
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={`px-3.5 py-1.5 text-[12px] font-medium rounded-lg transition-colors ${
              light
                ? 'text-slate-700 bg-slate-100 hover:bg-slate-200'
                : 'text-slate-300 bg-slate-700 hover:bg-slate-600'
            }`}
          >
            Cancel
          </button>
          {/* Deliberately no autoFocus — useFocusTrap moves focus to Cancel on
              mount (its passive effect runs after React's autoFocus commit, so
              the prop was inert), which is the safer default for a destructive
              confirm. */}
          <button
            type="button"
            onClick={onConfirm}
            className="px-3.5 py-1.5 text-[12px] font-semibold rounded-lg transition-colors bg-amber-500 text-white hover:bg-amber-600 shadow-sm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
