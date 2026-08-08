export const MIN_CREDITS = 10;
export const DEFAULT_DAILY_RATE = 0.015;
export const STABILIZED_DAILY_RATE = 0.008;
export const STABILIZATION_DAY = 30;

export interface ProjectionPoint {
  day: number;
  balance: number;
  rate: number;
}

export interface Projection {
  principal: number;
  days: number;
  finalBalance: number;
  reward: number;
  points: ProjectionPoint[];
  disclaimer: string;
}

function assertFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
}

export function calculateAutoCompound(principal: number, days: number, autoCompound = true): Projection {
  assertFinitePositive(principal, "principal");
  assertFinitePositive(days, "days");
  if (principal < MIN_CREDITS) {
    throw new Error(`principal must be at least ${MIN_CREDITS} credits`);
  }
  const wholeDays = Math.min(3650, Math.max(1, Math.floor(days)));
  const points: ProjectionPoint[] = [{ day: 0, balance: principal, rate: DEFAULT_DAILY_RATE }];
  let balance = principal;
  for (let day = 1; day <= wholeDays; day += 1) {
    const rate = day > STABILIZATION_DAY ? STABILIZED_DAILY_RATE : DEFAULT_DAILY_RATE;
    balance = autoCompound ? balance * (1 + rate) : balance + principal * rate;
    points.push({ day, balance, rate });
  }
  return {
    principal,
    days: wholeDays,
    finalBalance: balance,
    reward: balance - principal,
    points,
    disclaimer: "Расчет является игровой симуляцией и не обещает финансовый результат."
  };
}
