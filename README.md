# flightaware-tracklog
Convert a flight track from Flightaware to a G1000 csv file which can be imported into Foreflight as a track log.

## Installation

Requires `node`, `npm`, and optionally `nvm`. See [this guide](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) for details.

Clone this repository and install dependencies:

```shell
$ git clone https://github.com/npnicholson/flightaware-tracklog.git
$ cd flightaware-tracklog
$ nvm use
$ npm i
```

## Usage

For interactive mode, run `main.js`:
```shell
$ node main.js
```

Alternatively, use command line arguments:
```shell
$ node main.js https://www.flightaware.com/live/flight/... -i N12345 -m PA32
```

Output `csv` files are placed in the `outputs/` directory.
