const CMD = {
    VERSION: 'A',
    FAN_SPEED: 'B',
    READ_SENSORS: 'C',
    ANGLE: 'D',
    LED: 'E',
    ZERO_SENSORS: 'F',
    ZERO_MOTOR: 'G',
    SET_SCALER: 'H',
    GET_SCALERS: 'I',
    SET_LUT: 'J',
    GET_LUT: 'K',
    CALIBRATE_DISPLAY: 'L',
    SET_NETWORK: 'M'
};

const START_MARKER = 0x3A;
const END_MARKER = Buffer.from(';\n');

// Fixed-size binary RX payloads (raw IEEE-754 float bytes can coincidentally
// contain the ';' '\n' terminator sequence, so these must be sliced by known
// length rather than located by scanning for the terminator).
const RESPONSE_PAYLOAD_LENGTH = {
    [CMD.VERSION]: 1,
    [CMD.READ_SENSORS]: 16,
    [CMD.GET_SCALERS]: 12,
    [CMD.GET_LUT]: 40
};

function frame(command, payload = Buffer.alloc(0)) {
    return Buffer.concat([Buffer.from(':'), Buffer.from(command), payload, Buffer.from(';\n')]);
}

function parseFrames(buffer, expectedPayloadLength) {
    let remainder = buffer;
    const frames = [];
    while (true) {
        const start = remainder.indexOf(START_MARKER);
        if (start < 0) { remainder = Buffer.alloc(0); break; }
        if (remainder.length < start + 2) { remainder = remainder.subarray(start); break; }
        let end;
        if (expectedPayloadLength != null) {
            const frameEnd = start + 2 + expectedPayloadLength + END_MARKER.length;
            if (remainder.length < frameEnd) { remainder = remainder.subarray(start); break; }
            end = frameEnd - END_MARKER.length;
        } else {
            end = remainder.indexOf(END_MARKER, start + 2);
            if (end < 0) { remainder = remainder.subarray(start); break; }
        }
        frames.push(remainder.subarray(start, end + END_MARKER.length));
        remainder = remainder.subarray(end + END_MARKER.length);
    }
    return { frames, remainder };
}

module.exports = { CMD, frame, parseFrames, RESPONSE_PAYLOAD_LENGTH };
