// Stable selectors for AWOS Local UI elements.
// Prefer role+text selectors over fragile CSS selectors.
// Add data-testid to the UI only where no stable accessible label exists.

/** Mission Control company cards — match by company name text */
export function companyCard(name: string) {
  return `role=article[name="${name}"]`;
}

/** Company cards on mission-control page (general fallback) */
export const companyCards = 'role=article';

/** Review Queue nav link in the sidebar */
export const reviewQueueNav = 'role=link[name="Review Queue"]';

/** Trust layer / info button — usually a shield icon button in the shell header */
export const trustLayerButton = 'role=button[name*="trust" i], role=button[name*="shield" i], [data-testid="trust-layer-button"]';

/** Trust drawer — should contain "Database" and "matched" */
export const trustDrawer = '[data-testid="trust-drawer"], [role="dialog"][aria-label*="trust" i], [role="dialog"]';

/** Trust drawer close button */
export const trustDrawerClose = 'role=button[name="close" i], role=button[name="×" i], role=button[name="X" i], [aria-label="Close"]';

/** Command palette trigger — Cmd+K hint button or the search area */
export const commandPaletteTrigger = '[data-testid="command-palette-trigger"], [aria-label*="command" i], [aria-label*="search" i], [placeholder*="search" i], role=textbox[name="search" i]';

/** Review Queue text on the page (for URL assertion) */
export const reviewQueueHeading = 'role=heading[name="Review Queue"], role=heading[name*="review" i]';

/** Loading state indicator on mission control */
export const loadingIndicator = '[data-testid="loading"], [role="status"][aria-label*="loading" i], text=Loading';

/** Empty state for review queue */
export const emptyReviewQueue = 'text="No items in queue", text="Queue is empty", [data-testid="empty-review-queue"]';

/** Any error banner on mission control */
export const errorBanner = 'role=alert, [data-testid="error-banner"], text=No tenant configured';

/** "Companies (N)" count label in trust drawer */
export const companiesCountLabel = 'text=Companies';
