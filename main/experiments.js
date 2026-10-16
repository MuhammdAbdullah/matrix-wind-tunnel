// Raw passthrough only: lift/drag/pressure/velocity are the hardware's floats as-is.
// The Flowcode source has no coefficient formula (no rho/area/0.5*v^2 anywhere) and no
// per-drag-shape correction factor -- "dragShape" and "tapping" fields below are metadata
// written to the CSV/UI label only. Never consume them in a calculation.
const DRAG_SHAPES = ['Flat Surface', 'Cone', 'Tear Drop', 'Rough Ball', 'Semi Sphere', 'Smooth Ball'];

const EXPERIMENTS = [
    {
        id: 'pressureToVelocity',
        title: 'Convert Pressure to Velocity',
        sweepType: null,
        liveTraces: ['pressure', 'velocity'],
        fields: [],
        csvColumns: ['time', 'fanSpeed', 'pressure', 'velocity']
    },
    {
        id: 'pressureTappedCylinder',
        title: 'Pressure Tapped Cylinder',
        sweepType: 'angle',
        liveTraces: ['pressure'],
        fields: ['tapping'],
        csvColumns: ['time', 'angle', 'pressure', 'tappingChannel']
    },
    {
        id: 'pressureTappedAerofoil',
        title: 'Pressure Tapped Aerofoil',
        sweepType: 'angle',
        liveTraces: ['pressure'],
        fields: ['tapping'],
        csvColumns: ['time', 'angle', 'pressure', 'tappingChannel']
    },
    {
        id: 'liftCoefficient',
        title: 'Lift Coefficient',
        sweepType: 'angle',
        liveTraces: ['lift'],
        fields: ['dragShape'],
        csvColumns: ['time', 'angle', 'lift', 'dragShape']
    },
    {
        id: 'dragCoefficient',
        title: 'Drag Coefficient',
        sweepType: 'angle',
        liveTraces: ['drag'],
        fields: ['dragShape'],
        csvColumns: ['time', 'angle', 'drag', 'dragShape']
    },
    {
        id: 'stemRacing',
        title: 'Stem Racing',
        sweepType: 'fan',
        liveTraces: ['lift', 'drag', 'pressure'],
        fields: ['traceSelection'],
        csvColumns: ['time', 'fanSpeed', 'lift', 'drag', 'pressure']
    },
    {
        id: 'sensorsVsTime',
        title: 'Sensors vs Time',
        sweepType: null,
        liveTraces: ['lift', 'drag', 'pressure', 'velocity'],
        fields: [],
        csvColumns: ['time', 'lift', 'drag', 'pressure', 'velocity']
    },
    {
        id: 'custom',
        title: 'Custom',
        sweepType: null,
        liveTraces: ['lift', 'drag', 'pressure', 'velocity', 'fanSpeed', 'angle'],
        fields: ['customAxes'],
        csvColumns: ['time', 'customX', 'customY']
    }
];

const SWEEP_DEFAULTS = {
    angle: { start: -20, end: 45, step: 5, delay: 5000 },
    fan: { start: 0, end: 60, step: 10, delay: 5000 }
};

function getById(id) {
    return EXPERIMENTS.find((experiment) => experiment.id === id) || EXPERIMENTS[0];
}

module.exports = { EXPERIMENTS, DRAG_SHAPES, SWEEP_DEFAULTS, getById };
