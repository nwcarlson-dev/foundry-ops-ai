/**
 * Domain reference data for the synthetic foundry.
 *
 * Modeled on an aluminum sand + permanent-mold foundry: alloys, scrap reason
 * codes, routings, and the eight industries LeClaire actually serves. The scrap
 * vocabulary is the part a foundry person will read first, so it is real:
 * gas porosity, shrink, cold shut, and misrun are distinct failure modes with
 * distinct causes, and the generator attributes them accordingly.
 */

// The dataset is anchored to a fixed date so `npm run seed` is reproducible and
// the copilot's "today" is stable. Documented in docs/DATA.md and stated in the
// system prompt.
export const DATASET_TODAY = new Date('2026-07-29T00:00:00Z');
export const DATASET_MONTHS = 18;
export const DATASET_START = new Date(
    Date.UTC(
        DATASET_TODAY.getUTCFullYear(),
        DATASET_TODAY.getUTCMonth() - DATASET_MONTHS,
        DATASET_TODAY.getUTCDate(),
    ),
);

export const SEED = 20260729;

// ---------------------------------------------------------------------------
// Scrap reason codes (Epicor vocabulary)
// ---------------------------------------------------------------------------

export const SCRAP_REASONS = [
    ['GASPOR', 'Gas porosity', 'MELT'],
    ['SHRINK', 'Shrinkage porosity', 'MELT'],
    ['COLDSHUT', 'Cold shut', 'MOLD'],
    ['MISRUN', 'Misrun / incomplete fill', 'MOLD'],
    ['INCL', 'Inclusion', 'MELT'],
    ['CORE', 'Core break or shift', 'CORE'],
    ['HOTTEAR', 'Hot tear', 'MOLD'],
    ['DIMEN', 'Dimensional out of tolerance', 'DIMENSIONAL'],
    ['SANDINC', 'Sand inclusion', 'MOLD'],
    ['MACH', 'Machining damage', 'MECHANICAL'],
] as const;

/**
 * Thrive keeps its own defect vocabulary. It overlaps Epicor's but is not the
 * same list and does not use the same codes — another reason the two systems
 * cannot simply be joined.
 */
export const THRIVE_DEFECT_CODES = [
    'POROSITY-G',
    'POROSITY-S',
    'FILL-INCOMPLETE',
    'INCLUSION',
    'CORE-DEFECT',
    'DIM-OOT',
] as const;

export const EPICOR_TO_THRIVE_DEFECT: Record<string, string> = {
    GASPOR: 'POROSITY-G',
    SHRINK: 'POROSITY-S',
    COLDSHUT: 'FILL-INCOMPLETE',
    MISRUN: 'FILL-INCOMPLETE',
    INCL: 'INCLUSION',
    CORE: 'CORE-DEFECT',
    DIMEN: 'DIM-OOT',
};

// ---------------------------------------------------------------------------
// Work centers
// ---------------------------------------------------------------------------

export interface WorkCenterDef {
    wc_code: string;
    description: string;
    dept: string;
    shifts_per_day: number;
    hrs_per_shift: number;
    resources: number;
    queue_hrs: number;
}

export const WORK_CENTERS: WorkCenterDef[] = [
    { wc_code: 'MELT-F1',    description: 'Reverb furnace 1',           dept: 'MELT',       shifts_per_day: 3, hrs_per_shift: 8, resources: 1, queue_hrs: 2 },
    { wc_code: 'MELT-F3',    description: 'Reverb furnace 3',           dept: 'MELT',       shifts_per_day: 3, hrs_per_shift: 8, resources: 1, queue_hrs: 2 },
    { wc_code: 'MOLD-L1',    description: 'Sinto automatic mold line 1', dept: 'MOLD',      shifts_per_day: 2, hrs_per_shift: 8, resources: 1, queue_hrs: 6 },
    { wc_code: 'MOLD-L2',    description: 'Sinto automatic mold line 2', dept: 'MOLD',      shifts_per_day: 2, hrs_per_shift: 8, resources: 1, queue_hrs: 6 },
    { wc_code: 'PM-PRESS1',  description: 'Permanent mold press 1',     dept: 'MOLD',       shifts_per_day: 2, hrs_per_shift: 8, resources: 1, queue_hrs: 4 },
    { wc_code: 'PM-PRESS2',  description: 'Permanent mold press 2',     dept: 'MOLD',       shifts_per_day: 2, hrs_per_shift: 8, resources: 1, queue_hrs: 4 },
    { wc_code: 'CORE-1',     description: 'Cold box core room',         dept: 'CORE',       shifts_per_day: 2, hrs_per_shift: 8, resources: 2, queue_hrs: 5 },
    { wc_code: 'CLEAN-1',    description: 'Grind and finish cell 1',    dept: 'CLEAN',      shifts_per_day: 2, hrs_per_shift: 8, resources: 3, queue_hrs: 8 },
    { wc_code: 'CLEAN-2',    description: 'Grind and finish cell 2',    dept: 'CLEAN',      shifts_per_day: 2, hrs_per_shift: 8, resources: 3, queue_hrs: 8 },
    { wc_code: 'HT-1',       description: 'Heat treat / age oven',      dept: 'HEAT_TREAT', shifts_per_day: 3, hrs_per_shift: 8, resources: 1, queue_hrs: 12 },
    { wc_code: 'MACH-CELL1', description: 'CNC machining cell 1',       dept: 'MACHINE',    shifts_per_day: 2, hrs_per_shift: 8, resources: 1, queue_hrs: 10 },
    { wc_code: 'MACH-CELL2', description: 'CNC machining cell 2',       dept: 'MACHINE',    shifts_per_day: 2, hrs_per_shift: 8, resources: 1, queue_hrs: 10 },
];

// ---------------------------------------------------------------------------
// Parts
//
// pattern_num is Epicor's internal pattern id. thrive_pattern is the code the
// melt deck uses for the same tooling — deliberately a different namespace, and
// the only thing linking them is xref.part_pattern.
//
// thrive_pattern === null means the mapping was never established. Those parts
// show up in xref.unmatched, on purpose.
// ---------------------------------------------------------------------------

export interface PartDef {
    part_num: string;
    description: string;
    alloy: string;
    process: 'SAND' | 'PERM_MOLD';
    pattern_num: string;
    cavities: number;
    target_wt_lbs: number;
    machining_required: boolean;
    customer_code: string;
    industry: string;
    thrive_pattern: string | null;
}

export const PARTS: PartDef[] = [
    // Agriculture
    { part_num: '4471-BRKT', description: 'Loader arm bracket',        alloy: 'A356',   process: 'SAND',      pattern_num: 'P-4471', cavities: 2, target_wt_lbs: 14.6, machining_required: true,  customer_code: 'DEERE',   industry: 'Agriculture',       thrive_pattern: 'PTN-0113' },
    { part_num: '4482-BRKT', description: 'Loader arm bracket, RH',    alloy: 'A356',   process: 'SAND',      pattern_num: 'P-4482', cavities: 2, target_wt_lbs: 14.4, machining_required: true,  customer_code: 'DEERE',   industry: 'Agriculture',       thrive_pattern: 'PTN-0114' },
    { part_num: '4510-HUB',  description: 'Implement wheel hub',       alloy: '356-T6', process: 'SAND',      pattern_num: 'P-4510', cavities: 1, target_wt_lbs: 22.1, machining_required: true,  customer_code: 'AGCO',    industry: 'Agriculture',       thrive_pattern: 'PTN-0121' },

    // Valves & Pumps  (PTN-0207 serves two part numbers — same tooling, two customer part numbers)
    { part_num: '3320-HSG',  description: 'Pump housing, 3in',         alloy: '319',    process: 'SAND',      pattern_num: 'P-3320', cavities: 1, target_wt_lbs: 31.8, machining_required: true,  customer_code: 'GORMAN',  industry: 'Valves & Pumps',    thrive_pattern: 'PTN-0207' },
    { part_num: '3321-HSG',  description: 'Pump housing, 3in flanged', alloy: '319',    process: 'SAND',      pattern_num: 'P-3320', cavities: 1, target_wt_lbs: 32.4, machining_required: true,  customer_code: 'GORMAN',  industry: 'Valves & Pumps',    thrive_pattern: 'PTN-0207' },
    { part_num: '2870-IMP',  description: 'Impeller, closed face',     alloy: 'A356',   process: 'PERM_MOLD', pattern_num: 'P-2870', cavities: 1, target_wt_lbs: 8.2,  machining_required: true,  customer_code: 'GORMAN',  industry: 'Valves & Pumps',    thrive_pattern: 'PTN-0233' },
    { part_num: '2905-VBDY', description: 'Valve body, 2in',           alloy: '319',    process: 'SAND',      pattern_num: 'P-2905', cavities: 2, target_wt_lbs: 11.5, machining_required: true,  customer_code: 'VICTAULC',industry: 'Valves & Pumps',    thrive_pattern: 'PTN-0241' },

    // Heavy Truck
    { part_num: '5140-MANI', description: 'Intake manifold',           alloy: '356-T6', process: 'PERM_MOLD', pattern_num: 'P-5140', cavities: 1, target_wt_lbs: 18.9, machining_required: true,  customer_code: 'PACCAR',  industry: 'Heavy Truck',       thrive_pattern: 'PTN-0302' },
    { part_num: '5188-CVR',  description: 'Timing cover',              alloy: 'A356',   process: 'PERM_MOLD', pattern_num: 'P-5188', cavities: 2, target_wt_lbs: 6.7,  machining_required: true,  customer_code: 'PACCAR',  industry: 'Heavy Truck',       thrive_pattern: 'PTN-0308' },
    { part_num: '5240-BKPL', description: 'Brake backing plate',       alloy: '319',    process: 'SAND',      pattern_num: 'P-5240', cavities: 2, target_wt_lbs: 9.3,  machining_required: false, customer_code: 'BENDIX',  industry: 'Heavy Truck',       thrive_pattern: 'PTN-0315' },

    // Marine
    { part_num: '6015-CVR',  description: 'Outdrive cover',            alloy: '535',    process: 'PERM_MOLD', pattern_num: 'P-6015', cavities: 1, target_wt_lbs: 12.2, machining_required: true,  customer_code: 'MERCURY', industry: 'Marine',            thrive_pattern: 'PTN-0402' },
    { part_num: '6042-HSG',  description: 'Gearcase housing',          alloy: '535',    process: 'SAND',      pattern_num: 'P-6042', cavities: 1, target_wt_lbs: 27.5, machining_required: true,  customer_code: 'MERCURY', industry: 'Marine',            thrive_pattern: 'PTN-0409' },
    { part_num: '6077-BRKT', description: 'Transom bracket',           alloy: '356-T6', process: 'SAND',      pattern_num: 'P-6077', cavities: 2, target_wt_lbs: 15.1, machining_required: false, customer_code: 'BRP',     industry: 'Marine',            thrive_pattern: 'PTN-0417' },

    // Recreational Vehicles
    { part_num: '7120-STEP', description: 'Entry step frame',          alloy: 'A356',   process: 'SAND',      pattern_num: 'P-7120', cavities: 1, target_wt_lbs: 19.8, machining_required: false, customer_code: 'LIPPERT', industry: 'Recreational Vehicles', thrive_pattern: 'PTN-0503' },
    { part_num: '7166-MNT',  description: 'Awning mount',              alloy: 'A356',   process: 'PERM_MOLD', pattern_num: 'P-7166', cavities: 4, target_wt_lbs: 3.1,  machining_required: false, customer_code: 'LIPPERT', industry: 'Recreational Vehicles', thrive_pattern: 'PTN-0511' },

    // Railroad
    { part_num: '8200-BRG',  description: 'Bearing adapter cap',       alloy: '319',    process: 'SAND',      pattern_num: 'P-8200', cavities: 1, target_wt_lbs: 24.7, machining_required: true,  customer_code: 'WABTEC',  industry: 'Railroad',          thrive_pattern: 'PTN-0602' },
    { part_num: '8255-BOX',  description: 'Junction box, weatherproof', alloy: '356-T6', process: 'SAND',     pattern_num: 'P-8255', cavities: 2, target_wt_lbs: 7.9,  machining_required: false, customer_code: 'WABTEC',  industry: 'Railroad',          thrive_pattern: 'PTN-0611' },

    // Military & Defense
    { part_num: '9310-HSG',  description: 'Sight housing',             alloy: '356-T6', process: 'PERM_MOLD', pattern_num: 'P-9310', cavities: 1, target_wt_lbs: 5.4,  machining_required: true,  customer_code: 'OSHKOSH', industry: 'Military & Defense', thrive_pattern: 'PTN-0703' },
    { part_num: '9344-PLT',  description: 'Mounting plate, armored',   alloy: '535',    process: 'SAND',      pattern_num: 'P-9344', cavities: 1, target_wt_lbs: 33.2, machining_required: true,  customer_code: 'OSHKOSH', industry: 'Military & Defense', thrive_pattern: 'PTN-0710' },

    // Engine Components
    { part_num: '1105-PSTN', description: 'Piston blank',              alloy: 'A356',   process: 'PERM_MOLD', pattern_num: 'P-1105', cavities: 2, target_wt_lbs: 4.2,  machining_required: true,  customer_code: 'CUMMINS', industry: 'Engine Components', thrive_pattern: 'PTN-0802' },
    { part_num: '1140-CVR',  description: 'Front cover, diesel',       alloy: 'A356',   process: 'PERM_MOLD', pattern_num: 'P-1140', cavities: 1, target_wt_lbs: 10.8, machining_required: true,  customer_code: 'CUMMINS', industry: 'Engine Components', thrive_pattern: 'PTN-0809' },
    { part_num: '1188-PAN',  description: 'Oil pan, cast',             alloy: '319',    process: 'SAND',      pattern_num: 'P-1188', cavities: 1, target_wt_lbs: 21.3, machining_required: true,  customer_code: 'CUMMINS', industry: 'Engine Components', thrive_pattern: 'PTN-0815' },

    // Two parts deliberately never mapped to a Thrive pattern. These surface in
    // xref.unmatched and are the honest part of the reconciliation story.
    { part_num: '4590-ADPT', description: 'Hydraulic adapter',         alloy: '319',    process: 'SAND',      pattern_num: 'P-4590', cavities: 4, target_wt_lbs: 2.8,  machining_required: true,  customer_code: 'AGCO',    industry: 'Agriculture',       thrive_pattern: null },
    { part_num: '7201-TRIM', description: 'Trim retainer',             alloy: 'A356',   process: 'PERM_MOLD', pattern_num: 'P-7201', cavities: 6, target_wt_lbs: 1.4,  machining_required: false, customer_code: 'LIPPERT', industry: 'Recreational Vehicles', thrive_pattern: null },
];

/**
 * A pattern that exists on the melt deck but has no Epicor part mapping — a
 * sample/development pattern the ERP never got told about. Appears in
 * thrive.pour_record and therefore in xref.unmatched.
 */
export const ORPHAN_THRIVE_PATTERN = 'PTN-0455';

// ---------------------------------------------------------------------------
// Ignition tags
//
// tag_path is the historian's only key. 'Utilities/AirComp2/PressurePSI' is
// deliberately left out of xref.wc_tag: a real historian always has tags nobody
// mapped to a production asset.
// ---------------------------------------------------------------------------

export interface TagDef {
    tag_path: string;
    role: 'DEGAS' | 'TEMP' | 'CYCLE' | 'COUNT' | 'STATE' | 'PRESSURE';
    baseline: number;
    noise: number;
}

export const IGNITION_TAGS: TagDef[] = [
    { tag_path: 'Melt/Furnace3/DegasMinutes',      role: 'DEGAS',    baseline: 12.0,  noise: 0.9 },
    { tag_path: 'Melt/Furnace3/MetalTempF',        role: 'TEMP',     baseline: 1345,  noise: 12 },
    { tag_path: 'Melt/Furnace1/MetalTempF',        role: 'TEMP',     baseline: 1352,  noise: 12 },
    { tag_path: 'Molding/Line1/CycleTimeSec',      role: 'CYCLE',    baseline: 41.0,  noise: 2.4 },
    { tag_path: 'Molding/Line2/CycleTimeSec',      role: 'CYCLE',    baseline: 43.5,  noise: 2.6 },
    { tag_path: 'Molding/Line2/MoldCount',         role: 'COUNT',    baseline: 78,    noise: 9 },
    { tag_path: 'PermMold/Press1/ShotCount',       role: 'COUNT',    baseline: 55,    noise: 7 },
    { tag_path: 'Machining/Cell1/SpindleLoadPct',  role: 'STATE',    baseline: 62,    noise: 8 },
    { tag_path: 'Utilities/AirComp2/PressurePSI',  role: 'PRESSURE', baseline: 108,   noise: 3 },
];

export const WC_TAG_MAP: { wc_code: string; tag_prefix: string; signal_role: string }[] = [
    { wc_code: 'MELT-F3',    tag_prefix: 'Melt/Furnace3',     signal_role: 'DEGAS' },
    { wc_code: 'MELT-F1',    tag_prefix: 'Melt/Furnace1',     signal_role: 'TEMP' },
    { wc_code: 'MOLD-L1',    tag_prefix: 'Molding/Line1',     signal_role: 'CYCLE' },
    { wc_code: 'MOLD-L2',    tag_prefix: 'Molding/Line2',     signal_role: 'CYCLE' },
    { wc_code: 'PM-PRESS1',  tag_prefix: 'PermMold/Press1',   signal_role: 'COUNT' },
    { wc_code: 'MACH-CELL1', tag_prefix: 'Machining/Cell1',   signal_role: 'STATE' },
];

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

/** Veterans, present for the whole dataset. */
export const VETERAN_EMPLOYEES = [
    'E-1042', 'E-1088', 'E-1130', 'E-1177', 'E-1204', 'E-1251',
    'E-1298', 'E-1310', 'E-1366', 'E-1402', 'E-1455', 'E-1490',
];

/**
 * New-hire cohort that starts partway through the dataset on second shift in
 * molding. Signal 2 lives here.
 */
export const NEW_HIRE_EMPLOYEES = ['E-2011', 'E-2014', 'E-2019', 'E-2026'];

/**
 * Epicor customer code -> the display name used on the monday.com board.
 *
 * Two systems, two spellings of the same customer — which is itself a small
 * instance of the reconciliation problem. The important part is that a board
 * item must name the customer who actually buys that part: a Deere bracket
 * sitting on a Victaulic expedite is the kind of detail a foundry reader spots
 * immediately and stops trusting the rest of the demo over.
 */
export const CUSTOMER_DISPLAY: Record<string, string> = {
    DEERE:    'Deere & Co',
    AGCO:     'AGCO',
    GORMAN:   'Gorman-Rupp',
    VICTAULC: 'Victaulic',
    PACCAR:   'PACCAR',
    BENDIX:   'Bendix',
    MERCURY:  'Mercury Marine',
    BRP:      'BRP',
    LIPPERT:  'Lippert',
    WABTEC:   'Wabtec',
    OSHKOSH:  'Oshkosh Defense',
    CUMMINS:  'Cummins',
};

export const MONDAY_CUSTOMERS = Object.values(CUSTOMER_DISPLAY);
