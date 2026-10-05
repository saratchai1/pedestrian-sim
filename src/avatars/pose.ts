export type HumanWalkPose = {
  legSwing: number;
  armSwing: number;
  leftKneeBend: number;
  rightKneeBend: number;
  leftElbowBend: number;
  rightElbowBend: number;
  bob: number;
  sway: number;
  lean: number;
  breath: number;
  moving: boolean;
};

export function humanWalkPose(
  speed: number,
  time: number,
  agentIndex: number,
): HumanWalkPose {
  const safeSpeed = Math.max(0, speed);
  const activity = Math.min(1, Math.max(0, (safeSpeed - 0.03) / 0.35));
  const idlePhase = time * 1.7 + agentIndex * 0.37;
  const breath = Math.sin(idlePhase) * 0.008;

  if (activity === 0) {
    return {
      legSwing: 0,
      armSwing: 0,
      leftKneeBend: 0,
      rightKneeBend: 0,
      leftElbowBend: 0.1,
      rightElbowBend: 0.1,
      bob: 0,
      sway: 0,
      lean: 0,
      breath,
      moving: false,
    };
  }

  const phase =
    time * (4.5 + Math.min(safeSpeed, 2.4) * 2.2) +
    agentIndex * 1.61803398875;

  const stride = Math.sin(phase);
  const legSwing = stride * 0.58 * activity;
  const armSwing = -legSwing * 0.82;

  const leftKneeBend =
    Math.max(0, -stride) * 0.72 * activity;
  const rightKneeBend =
    Math.max(0, stride) * 0.72 * activity;

  const leftElbowBend =
    (0.12 + Math.max(0, stride) * 0.22) * activity;
  const rightElbowBend =
    (0.12 + Math.max(0, -stride) * 0.22) * activity;

  const bob =
    Math.abs(Math.sin(phase * 2)) * 0.024 * activity;
  const sway =
    Math.sin(phase) * 0.025 * activity;
  const lean =
    Math.min(0.08, safeSpeed * 0.035) * activity;

  return {
    legSwing,
    armSwing,
    leftKneeBend,
    rightKneeBend,
    leftElbowBend,
    rightElbowBend,
    bob,
    sway,
    lean,
    breath,
    moving: activity > 0.08,
  };
}
