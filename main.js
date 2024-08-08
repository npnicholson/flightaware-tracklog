const parseKML = require('parse-kml');
const format = require('date-fns/format');
const timezone_mock = require('timezone-mock');
const fsp = require('fs/promises');
const fs = require('fs');
const inquirer = require('inquirer');
const { URL } = require('url');

const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');

// Define the command line argument structure
const optionDefinitions = [
    { name: 'url', alias: 'u', type: String, defaultOption: true },
    { name: 'ident', alias: 'i', type: String },
    { name: 'model', alias: 'm', type: String },
    { name: 'help', alias: 'h', type: Boolean }
];
const args = commandLineArgs(optionDefinitions);

// Set up the command line help
const helpSections = [
    {
        header: 'ForeFlight TrackLog Generator',
        content: 'Generates a G1000 track log from a FlightAware Link which can be imported into ForeFlight. Run without arguments interactively supply the required information.'
    },
    {
        header: 'Synopsis',
        content: [
            '$ node main.js',
            '$ node main.js [{bold -i} {underline ident} {bold -m} {underline model}] {underline url}',
            '$ node main.js {bold --help}'
        ]
    },
    {
        header: 'Options',
        optionList: [
            {
                name: 'url',
                alias: 'u',
                defaultOption: true,
                typeLabel: '{underline url}',
                description: 'The FlightAware url to use. This should be a specific flight.'
            },
            {
                name: 'ident',
                alias: 'i',
                typeLabel: '{underline aircraft ident}',
                description: 'Optional aircraft ident to use. If unset, the ident will be inferred from the FlightAware url.'
            },
            {
                name: 'model',
                alias: 'm',
                typeLabel: '{underline aircraft model}',
                description: 'Optional aircraft model to use. If unset, it will default to the \'C172\'.'
            },
            {
                name: 'help',
                alias: 'h',
                type: Boolean,
                description: 'Print this usage guide.'
            }
        ]
    }
]
const usage = commandLineUsage(helpSections)

// ---------- Helpers ---------- //
// ------------------------------ //
// Calculate the distance between two lat/lons
// @see: https://stackoverflow.com/questions/18883601/function-to-calculate-distance-between-two-coordinates
// Modified to produce output in nm rather than km

function getDistanceFromLatLonInNm(lat1, lon1, lat2, lon2) {
    var R = 6378.137; // Radius of the earth in km
    var dLat = deg2rad(lat2 - lat1);  // deg2rad below
    var dLon = deg2rad(lon2 - lon1);
    var a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2)
        ;
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    var d = R * c; // Distance in km
    return d / 1.8520000016; // Distance in nm
}
function deg2rad(deg) {
    return deg * (Math.PI / 180)
}

/* Calculate the bearing between two lat/lons
@see: https://stackoverflow.com/questions/46590154/calculate-bearing-between-2-points-with-javascript */
function toRadians(degrees) {
    return degrees * Math.PI / 180;
};
function toDegrees(radians) {
    return radians * 180 / Math.PI;
}
function bearing(startLat, startLng, destLat, destLng) {
    startLat = toRadians(startLat);
    startLng = toRadians(startLng);
    destLat = toRadians(destLat);
    destLng = toRadians(destLng);

    y = Math.sin(destLng - startLng) * Math.cos(destLat);
    x = Math.cos(startLat) * Math.sin(destLat) -
        Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
    brng = Math.atan2(y, x);
    brng = toDegrees(brng);
    return (brng + 360) % 360;
}

// ------------ main ------------ //
// ------------------------------ //
async function main() {

    // Set up stubs for later use
    let url, ident, model = 'C172';

    // Go ahead and handle command line help if needed
    if (args.help) {
        console.log(usage);
        process.exit(0);
    }

    try {

        // If a url was passed in through the command line, then grab the url and ident from there.
        // Otherwise, use inquirer to grab information
        if (args.url !== undefined) {
            url = new URL(args.url);
            if (args.ident !== undefined) ident = args.ident;
            else ident = url.pathname.split('/')[3];

            if (args.model !== undefined) model = args.model;
        } else {

            // Grab some information from the user about this flight
            let res = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'url',
                    message: 'Paste the FlightAware link'
                },
            ]);

            url = new URL(res.url);

            res = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'ident',
                    message: 'Provide N Number',
                    default: url.pathname.split('/')[3]
                },
                {
                    type: 'input',
                    name: 'model',
                    message: 'Provide the model of aircraft',
                    default: model
                }
            ]);
            ident = res.ident;
            model = res.model;
        }
    } catch (e) {
        if (e.code === 'ERR_INVALID_URL') console.error('Invalid FlightAware Url!');
        process.exit(1);
    }

    // Mock UTC time so that all of our date calculations happen in UTC instead of local
    timezone_mock.register('UTC');

    // Garmin G1000 Track log header @see: https://www.reddit.com/r/flying/comments/6jgntl/find_garmin_g1000_sample_csv_file/
    const header = `#airframe_info, log_version="1.00", airframe_name="${model.toLocaleUpperCase()}", unit_software_part_number="000-A0000-0A", unit_software_version="9.00", system_software_part_number="000-A0000-00", system_id="${ident.toLocaleUpperCase()}", mode=NORMAL,\n#yyy-mm-dd, hh:mm:ss,   hh:mm,  ident,      degrees,      degrees, ft Baro,  inch,  ft msl, deg C,     kt,     kt,     fpm,    deg,    deg,      G,      G,   deg,   deg, volts,   gals,   gals,      gph,      psi,   deg F,     psi,     Hg,    rpm,   deg F,   deg F,   deg F,   deg F,   deg F,   deg F,   deg F,   deg F,  ft wgs,  kt, enum,    deg,    MHz,    MHz,     MHz,     MHz,    fsd,    fsd,     kt,   deg,     nm,    deg,    deg,   bool,  enum,   enum,   deg,   deg,   fpm,   enum,   mt,    mt,     mt,    mt,     mt\n  Lcl Date, Lcl Time, UTCOfst, AtvWpt,     Latitude,    Longitude,    AltB, BaroA,  AltMSL,   OAT,    IAS, GndSpd,    VSpd,  Pitch,   Roll,  LatAc, NormAc,   HDG,   TRK, volt1,  FQtyL,  FQtyR, E1 FFlow, E1 FPres, E1 OilT, E1 OilP, E1 MAP, E1 RPM, E1 CHT1, E1 CHT2, E1 CHT3, E1 CHT4, E1 EGT1, E1 EGT2, E1 EGT3, E1 EGT4,  AltGPS, TAS, HSIS,    CRS,   NAV1,   NAV2,    COM1,    COM2,   HCDI,   VCDI, WndSpd, WndDr, WptDst, WptBrg, MagVar, AfcsOn, RollM, PitchM, RollC, PichC, VSpdG, GPSfix,  HAL,   VAL, HPLwas, HPLfd, VPLwas\n`;

    let output = '';

    // Get the KML to parse via the URL the user provided
    const data = await parseKML.toJson(url.href + '/google_earth');

    // Get the third feature (the first is the origin and the second is the destination)
    const feat = data.features[2];

    // Get the coordinates and times from the feature
    const coordinates = feat.geometry.coordinates;
    const times = feat.properties.coordTimes;

    // Get the number of coordinates
    const len = coordinates.length;

    // Go through each coordinate and grab the time that goes with it
    let rows = []
    for (let i = 0; i < len; i++) {
        const coord = coordinates[i];
        const t = new Date(times[i])

        // Parse out lat, lon, and alt
        const lon = coord[0];
        const lat = coord[1];
        
        // FlightAware KML altitude is in meters so we need to convert to feet
        const alt = Math.round(coord[2] *  3.280839895);

        // Calculate dates
        const date = format(t, 'yyyy-LL-dd');
        const time = format(t, 'HH:mm:ss');

        // Tell ForeFlight these times are UTC
        const zone = '-00:00'

        // Placeholder for pitch and bank
        const pitch = String(0);
        const bank = String(0);

        rows.push({ lat, lon, alt, t, date, time, zone, pitch, bank });
    }

    // Remove any duplicate rows from the input
    // rows = rows.filter((row, index, self) => self.findIndex(t => t.lat === row.lat && t.lon === row.lon) === index)
    rows = rows.filter((row, index, self) => self.findIndex(t => t.t.getTime() === row.t.getTime()) === index)

    // Calculate a speed and heading for each entry based on two points
    let last = rows[0]
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        // Calculate distance and time between the two points
        const dist = getDistanceFromLatLonInNm(last.lat, last.lon, row.lat, row.lon);
        const time = row.t - last.t;

        const heading = bearing(last.lat, last.lon, row.lat, row.lon);

        // If the distance or times are the same, the speed can't be calculated
        if (dist === 0) {
            row.spd = undefined;
            row.hdg = undefined;
        }

        // Otherwise, time is reported in ms so convert to seconds, then hours
        else {
            row.spd = Math.floor(dist / (time / 1000 / 3600));
            row.hdg = Math.floor(heading);
        }

        // Set the last point to this point for the next loop
        last = row
    }

    // Set the first speed to be the second row's speed if it is undefined
    if (rows[0].spd === undefined) rows[0].spd = rows[1].spd;
    if (rows[0].hdg === undefined) rows[0].hdg = rows[1].hdg;

    // Write to the output file
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        // Write this row to the output
        output += `${row.date.padStart(10)},${row.time.padStart(9)},${row.zone.padStart(8)},       ,${String(row.lat).padEnd(13)},${String(row.lon).padEnd(13)},        ,      ,${String(row.alt).padStart(8)},      ,       ,${String(row.spd).padStart(7)},        ,${row.pitch.padStart(7)},${row.bank.padStart(7)},       ,        ,     ,      ,      ,       ,       ,         ,         ,        ,        ,       ,       ,        ,        ,        ,        ,        ,        ,        ,        ,        ,    ,     ,${String(row.hdg).padStart(7)}\n`;
    }

    // Create a output directory if one does not exist

    const directoryPath = './outputs';

    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath);
    }

    const filename = `outputs/${ident.toLocaleUpperCase()}-${format(rows[0].t, 'yyyy-LL-dd-HH:mm')}.csv`;

    console.log(filename);
    await fsp.writeFile(filename, header + output);
}

main();