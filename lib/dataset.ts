/**
 * Facts about the dataset that both the tools and the system prompt need.
 *
 * The dataset's "today" is pinned rather than using the wall clock, so answers
 * are stable and reproducible. Every tool that means "now" means this.
 */

export const DATASET_TODAY = '2026-07-29';
export const DATASET_START = '2025-01-29';

/** Nominal shop rates. Not real LeClaire numbers — see docs/DATA.md. */
export const LABOR_RATE_PER_HR: Record<string, number> = {
    MELT: 38,
    MOLD: 34,
    CORE: 32,
    CLEAN: 29,
    HEAT_TREAT: 31,
    MACHINE: 45,
};
export const DEFAULT_LABOR_RATE = 34;

/** Nominal aluminum cost, $/lb of metal charged. */
export const ALUMINUM_COST_PER_LB = 1.42;

export const SCRAP_REASON_GLOSSARY: Record<string, string> = {
    GASPOR: 'Gas porosity — dissolved hydrogen in the melt; a MELT-side cause that surfaces at forming',
    SHRINK: 'Shrinkage porosity — inadequate feeding during solidification',
    COLDSHUT: 'Cold shut — two metal fronts met without fusing; pour temperature or fill rate',
    MISRUN: 'Misrun — cavity did not fill completely',
    INCL: 'Inclusion — oxide or dross entrained in the metal',
    CORE: 'Core break or shift',
    HOTTEAR: 'Hot tear — cracking during solidification under restraint',
    DIMEN: 'Dimensional out of tolerance',
    SANDINC: 'Sand inclusion — mold or core erosion',
    MACH: 'Machining damage — lost after machining, so it carries the most accumulated cost',
};
