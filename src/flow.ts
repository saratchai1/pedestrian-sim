export function effectiveExitWidth(
  width: number,
  boundaryLayer: number,
  minimumWidth = 0.05,
) {
  return Math.max(
    minimumWidth,
    Math.max(0, width) - Math.max(0, boundaryLayer) * 2,
  );
}

export function configuredExitRate(
  width: number,
  specificFlow: number,
  boundaryLayer: number,
) {
  return Math.max(0.01, specificFlow) *
    effectiveExitWidth(width, boundaryLayer);
}

export function nextAllowedPassTime(
  currentTime: number,
  configuredRate: number,
) {
  if (!Number.isFinite(configuredRate)) return currentTime;
  return currentTime + 1 / Math.max(0.01, configuredRate);
}

export function measuredExitRate(
  passed: number,
  firstPassAt: number | null,
  lastPassAt: number | null,
) {
  if (
    passed <= 1 ||
    firstPassAt == null ||
    lastPassAt == null ||
    lastPassAt <= firstPassAt
  ) {
    return null;
  }

  return (passed - 1) / (lastPassAt - firstPassAt);
}
