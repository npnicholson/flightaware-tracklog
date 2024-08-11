import fs from 'fs';
import { URL } from 'url';
import path from 'node:path';

import pkg from 'parse-kml';
const { toJson } = pkg;
import { format } from 'date-fns';
import timezone_mock from 'timezone-mock';
import inquirer from 'inquirer';
import chalk from 'chalk';
import commandLineArgs from 'command-line-args';
import commandLineUsage from 'command-line-usage';

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
            '$ node main.js [{bold -i} {underline ident}] [{bold -m} {underline model}] [{bold -o} {underline file}] [-v|-q] {underline url} [{underline url}...]',
            '$ node main.js {bold --help}'
        ]
    },
    {
        header: 'Options',
        optionList: [
            {
                name: 'urls',
                alias: 'u',
                defaultOption: true,
                typeLabel: '{underline url(s)}',
                description: 'The FlightAware url(s) to use. This should be a specific flight. Flights will be compiled into a single output file in the order they are given.'
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
                name: 'output',
                alias: 'o',
                typeLabel: '{underline file}',
                description: 'Optional output file path. By default, outputs are put in the ./outputs folder'
            },
            {
                name: 'quiet',
                alias: 'q',
                description: 'Suppresses non-prompt console outputs.'
            },
            {
                name: 'verbose',
                alias: 'v',
                description: 'Prints additional information.'
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

// Define the command line argument structure
const optionDefinitions = [
    { name: 'urls', alias: 'u', type: String, multiple: true, defaultOption: true },
    { name: 'ident', alias: 'i', type: String },
    { name: 'model', alias: 'm', type: String },
    { name: 'output', alias: 'o', type: String },
    { name: 'quiet', alias: 'q', type: Boolean },
    { name: 'verbose', alias: 'v', type: Boolean },
    { name: 'help', alias: 'h', type: Boolean }
];

let args;
try {
    args = commandLineArgs(optionDefinitions);
} catch (e) {
    console.error('Unknown Option:', e.optionName);
    console.log(usage);
    process.exit(1);
}

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

    const y = Math.sin(destLng - startLng) * Math.cos(destLat);
    const x = Math.cos(startLat) * Math.sin(destLat) -
        Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
    let brng = Math.atan2(y, x);
    brng = toDegrees(brng);
    return (brng + 360) % 360;
}

// ------------ main ------------ //
// ------------------------------ //
async function main() {

    let verb = () => {};

    // Set up stubs for later use
    let urls = [];
    let ident = args.ident;
    let model = args.model || 'C172';

    // Go ahead and handle command line help if needed
    if (args.help) {
        console.log(usage);
        process.exit(0);
    }

    if (args.quiet) {
        console.log = () => {};
    } else if (args.verbose) {
        verb = (...args) => {
            const timestamp = chalk.dim(`${process.uptime().toPrecision(2)}:`.padStart(6, '0'));
            console.log(timestamp, ...args);
        }
    }

    try {

        // If a url was passed in through the command line, then grab the url and ident from there.
        // Otherwise, use inquirer to grab information
        if (args.urls !== undefined) {
            verb('Using command line arguments');

            // Grab the urls from the command line arguments and convert them to URL objects. This 
            // will also help us check to make sure they are valid urls. If not, exit with an error.
            urls = args.urls.map(val => new URL(val.trim()));

            // Set the ident to the ident in the url of the first url. If the ident was set by 
            // command line argument then we will use that instead. FlightAware links follow the
            // following format:
            // https://www.flightaware.com/live/flight/IDENT/history/DATE/TIME/FROM_APT/TO_APT
            if (ident === undefined) ident = urls[0].pathname.split('/')[3];
        } else {
            verb('Using interactive prompt');

            // Grab some information from the user about this flight, starting with at least one 
            // url
            let res = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'url',
                    message: 'Paste the FlightAware link:'
                },
            ]);
            urls.push(new URL(res.url.trim()));

            // Loop as long as there are more urls to receive. When the user enters a blank url,
            // stop looping.
            while (true) {
                let res = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'url',
                        message: 'Paste an optional additional FlightAware link:'
                    },
                ]);
                if (res.url !== '') urls.push(new URL(res.url.trim()));
                else break;
            }

            // Set the default ident to the ident in the url of the first url. If the ident was 
            // set by command line argument then we will use that instead
            if (ident === undefined) ident = urls[0].pathname.split('/')[3];

            // Ask for an N number and model for the aircraft. 
            const prompts = [];
            if (args.ident === undefined) prompts.push({
                type: 'input',
                name: 'ident',
                message: 'Provide N Number:',
                default: ident
            });
            if (args.model === undefined) prompts.push({
                type: 'input',
                name: 'model',
                message: 'Provide the model of aircraft:',
                default: model
            })
            res = await inquirer.prompt(prompts);
            ident = res.ident || ident;
            model = res.model || model;
        }
    } catch (e) {
        if (e.code === 'ERR_INVALID_URL') console.error('Invalid FlightAware Url:', e.input);
        else throw e;
        process.exit(1);
    }

    // Mock UTC time so that all of our date calculations happen in UTC instead of local
    timezone_mock.register('UTC');

    // Remove duplicate urls
    const old_urls_length = urls.length;
    urls = urls.filter((url, index, self) => self.findIndex(t => t.href === url.href) === index);
    const number_urls_removed = old_urls_length - urls.length;
    if (number_urls_removed > 0) verb(`Removed ${chalk.green(number_urls_removed)} duplicate url${number_urls_removed > 1 ? 's' : ''}`);

    verb('Using the following urls:');
    for (const url of urls) verb(` - ${chalk.blue.underline(url.href)}`);
    verb(`Using ${chalk.blue(ident)} as the aircraft ident`);
    verb(`Using ${chalk.blue(model)} as the aircraft model`);

    // Garmin G1000 Track log header @see: https://www.reddit.com/r/flying/comments/6jgntl/find_garmin_g1000_sample_csv_file/
    const header = `#airframe_info, log_version="1.00", airframe_name="${model.toLocaleUpperCase()}", unit_software_part_number="000-A0000-0A", unit_software_version="9.00", system_software_part_number="000-A0000-00", system_id="${ident.toLocaleUpperCase()}", mode=NORMAL,\n#yyy-mm-dd, hh:mm:ss,   hh:mm,  ident,      degrees,      degrees, ft Baro,  inch,  ft msl, deg C,     kt,     kt,     fpm,    deg,    deg,      G,      G,   deg,   deg, volts,   gals,   gals,      gph,      psi,   deg F,     psi,     Hg,    rpm,   deg F,   deg F,   deg F,   deg F,   deg F,   deg F,   deg F,   deg F,  ft wgs,  kt, enum,    deg,    MHz,    MHz,     MHz,     MHz,    fsd,    fsd,     kt,   deg,     nm,    deg,    deg,   bool,  enum,   enum,   deg,   deg,   fpm,   enum,   mt,    mt,     mt,    mt,     mt\n  Lcl Date, Lcl Time, UTCOfst, AtvWpt,     Latitude,    Longitude,    AltB, BaroA,  AltMSL,   OAT,    IAS, GndSpd,    VSpd,  Pitch,   Roll,  LatAc, NormAc,   HDG,   TRK, volt1,  FQtyL,  FQtyR, E1 FFlow, E1 FPres, E1 OilT, E1 OilP, E1 MAP, E1 RPM, E1 CHT1, E1 CHT2, E1 CHT3, E1 CHT4, E1 EGT1, E1 EGT2, E1 EGT3, E1 EGT4,  AltGPS, TAS, HSIS,    CRS,   NAV1,   NAV2,    COM1,    COM2,   HCDI,   VCDI, WndSpd, WndDr, WptDst, WptBrg, MagVar, AfcsOn, RollM, PitchM, RollC, PichC, VSpdG, GPSfix,  HAL,   VAL, HPLwas, HPLfd, VPLwas\n`;

    let output = '';
    let first_timestamp = null;

    verb('Processing URLs');
    try {
        // Run through each of the urls we received and parse their KLM files
        for (const url of urls) {
            // Build the link to the google_earth KLM file. If the url already ends in google_earth,
            // then we can assume we already have the full link. Otherwise add google_earth to the
            // end
            let link;
            if (url.href.split('/').pop() === 'google_earth') link = url.href;
            else link = url.href + '/google_earth';

            verb(` => Fetching ${chalk.blue.underline(link)}`);

            // Grab the KLM file and parse it
            const data = await toJson(link);

            // Get the third feature (the first is the origin and the second is the destination)
            const feat = data.features[2];

            // Get the coordinates and times from the feature
            const coordinates = feat.geometry.coordinates;
            const times = feat.properties.coordTimes;

            // Get the number of coordinates
            const len = coordinates.length;
            verb(`    ${len} coordinates found`);

            // If we have 1 or 0 coordinates, then this KLM is too short.
            if (len <= 1) {
                verb(`    ${chalk.red('Skipping URL - not enough coordinates')}`);
                continue;
            }

            // Go through each coordinate and grab the time that goes with it
            let rows = []
            for (let i = 0; i < len; i++) {
                const coord = coordinates[i];
                const t = new Date(times[i])

                // Parse out lat, lon, and alt
                const lon = coord[0];
                const lat = coord[1];

                // FlightAware KML altitude is in meters so we need to convert to feet
                const alt = Math.round(coord[2] * 3.280839895);

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
            const old_rows_length = rows.length;
            rows = rows.filter((row, index, self) => self.findIndex(t => t.t.getTime() === row.t.getTime()) === index)
            const number_rows_removed = old_rows_length - rows.length;
            if (number_rows_removed > 0) verb(`    Removed ${chalk.green(number_rows_removed)} duplicate coordinate${number_rows_removed > 1 ? 's' : ''}`);

            verb(`    Calculating speed and heading`);
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

            verb(`    Storing coordinates`);
            // Write to the output file
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];

                // Write this row to the output
                output += `${row.date.padStart(10)},${row.time.padStart(9)},${row.zone.padStart(8)},       ,${String(row.lat).padEnd(13)},${String(row.lon).padEnd(13)},        ,      ,${String(row.alt).padStart(8)},      ,       ,${String(row.spd).padStart(7)},        ,${row.pitch.padStart(7)},${row.bank.padStart(7)},       ,        ,     ,      ,      ,       ,       ,         ,         ,        ,        ,       ,       ,        ,        ,        ,        ,        ,        ,        ,        ,        ,    ,     ,${String(row.hdg).padStart(7)}\n`;
            }

            // Grab the very first timestamp. Once first_timestamp is set, it wont be set again
            if (first_timestamp === null) first_timestamp = rows[0].t
        }
    } catch (e) {
        console.error('Error parsing KLM', e);
        process.exit(1);
    }

    verb(`Done parsing KMLs`);

    // Write the file to the outputs folder
    let filename = args.output || `outputs/${ident.toLocaleUpperCase()}-${format(first_timestamp, 'yyyy-LL-dd-HH:mm')}.csv`;

    // Create a output directory if one does not exist
    const directoryPath = path.dirname(filename);
    if (!fs.existsSync(directoryPath)) {
        verb(`Creating directory ${directoryPath}`);
        fs.mkdirSync(directoryPath, { recursive: true });
    }

    verb(`Writing to ${filename}`);
    try {
        fs.writeFileSync(filename, header + output);
    } catch (e) {
        console.error("Error writing to file:", filename);
        process.exit(1);
    }

    console.log(filename);
}

main();