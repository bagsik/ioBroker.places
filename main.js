/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

var utils = require(__dirname + '/lib/utils');
var geolib = require('geolib');

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.template.0
var adapter = new utils.Adapter('places');

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
    try {
        callback();
    } catch (e) {
        callback();
    }
});

// Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
adapter.on('message', function (obj) {
    if (typeof obj !== 'object' || !obj.message || obj.command !== 'send') {
        adapter.log.warn('Ignoring invalid message!');
        return;
    }

    if (!obj.message.user || !obj.message.latitude || !obj.message.longitude || !obj.message.timestamp) {
        adapter.log.warn('Ignoring incomplete message!')
        return;
    }

    // ensure having correct timestamp
    obj.message.timestamp = Number((obj.message.timestamp + '0000000000000').substring(0, 13));
    adapter.log.debug('Received message with location info: ' + JSON.stringify(obj.message));

    // process message
    var response = processMessage(obj.message);

    // send response in callback if required, response will be the enriched location
    if (obj.callback) {
        adapter.log.debug('Found callback, returning result: ' + JSON.stringify(response));
        adapter.sendTo(obj.from, obj.command, response, obj.callback);
    }
});

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', function () {
    adapter.getForeignObject('system.config', null, function (err, obj) {
        if (err) {
            adapter.log.info("Adapter could not read latitude/longitude from system config!");
        } else {
            adapter.config.latitude = obj.common.latitude;
            adapter.config.longitude = obj.common.longitude;
            adapter.subscribeStates('*');
            main();
        }
    });
});

adapter.on('stateChange', function (id, state) {
    if (id && state && !state.ack) {
        id = id.substring(adapter.namespace.length + 1);
        switch (id) {
            case 'clearHome':
                adapter.setState('personsAtHome', JSON.stringify([]), false);
                break;
            case 'personsAtHome':
                var homePersons =state.val ? JSON.parse(state.val) : [];
                adapter.setState('numberAtHome', homePersons.length, true);
                adapter.setState('anybodyAtHome', homePersons.length > 0, true);
                break;
            default:
                break;
        }
    }
});

function main() {
    adapter.log.debug("Current configuration: " + JSON.stringify(adapter.config));
    checkInstanceObjects();
}

function processMessage(msg) {
    msg.user = msg.user || 'Dummy';

    msg.date = adapter.formatDate(new Date(msg.timestamp), "YYYY-MM-DD hh:mm:ss");
    msg.atHome = geolib.isPointInCircle(msg, adapter.config, adapter.config.radius);
    msg.homeDistance = geolib.getDistance(msg, adapter.config) || 0;

    if (msg.atHome) {
        msg.name = adapter.config.homeName || 'Home';
    } else {
        for (var place of adapter.config.places) {
            adapter.log.silly("Checking if position is at '" + place.name + "' (radius: " + place.radius + "m)");
            var isThere = geolib.isPointInCircle(msg, place, place.radius);
            if (isThere) {
                msg.name = place.name;
                adapter.log.debug("Place found, skipping other checks");
                break;
            }
        }
    }

    msg.name = msg.name || '';

    adapter.log.debug('Analyzed place: ' + JSON.stringify(msg));

    // fix whitespaces in username
    var dpUser = msg.user.replace(/\s|\./g, '_');

    // create user device (if not exists)
    adapter.getObject(dpUser, function (err, obj) {
        if (err || !obj) {
            // create device for user
            adapter.setObjectNotExists(dpUser, { type: 'device', common: { id: dpUser, name: dpUser }, native: { name: dpUser, device: dpUser } });

            // create states
            adapter.setObjectNotExists(dpUser + '.place', { type: 'state', common: { role: 'text', name: 'place', read: true, write: false, type: 'string' }, native: {} });
            adapter.setObjectNotExists(dpUser + '.timestamp', { type: 'state', common: { role: 'value', name: 'timestamp', read: true, write: false, type: 'number' }, native: {} });
            adapter.setObjectNotExists(dpUser + '.distance', { type: 'state', common: { role: 'value', name: 'distance', read: true, write: false, type: 'number' }, native: {} });
            adapter.setObjectNotExists(dpUser + '.latitude', { type: 'state', common: { role: 'value.gps.latitude', name: 'latitude', read: true, write: false, type: 'number' }, native: {} });
            adapter.setObjectNotExists(dpUser + '.longitude', { type: 'state', common: { role: 'value.gps.longitude', name: 'longitude', read: true, write: false, type: 'number' }, native: {} });
            adapter.setObjectNotExists(dpUser + '.date', { type: 'state', common: { role: 'text', name: 'date', read: true, write: false, type: 'string' }, native: {} });

            setStates(dpUser, msg);
        } else if (!err && obj) {
            setStates(dpUser, msg);
        }
    });

    return msg;
}

function setStates(dpUser, loc) {
    adapter.getState(dpUser + '.timestamp', function (err, state) {
        if (!err && state && state.val) {
            var oldTs = Number(state.val);
            if (oldTs < loc.timestamp) {
                setValues(dpUser, loc);
            } else {
                adapter.log.warn("Found a newer place for this user: skipping update");
            }
        } else {
            setValues(dpUser, loc);
        }
    });
}

function setValues(dpUser, loc) {
    setValue(dpUser, "timestamp", loc.timestamp);
    setValue(dpUser, "date", loc.date);
    setValue(dpUser, "place", loc.name);
    setValue(dpUser, "latitude", loc.latitude);
    setValue(dpUser, "longitude", loc.longitude);
    setValue(dpUser, "distance", loc.homeDistance);

    analyzePersonsAtHome(loc);
}

function setValue(user, key, value) {
    adapter.setState(user + "." + key, { val: value, ack: true }, function (err, obj) {
        if (err) {
            adapter.log.warn("Error while setting value '" + value + "' for '" + user + "." + key + "' -> " + err);
        }
    });
}

function analyzePersonsAtHome(loc) {
    var homePersons;

    adapter.getState('personsAtHome', function (err, obj) {
        if (err) return;
        homePersons = obj ? (obj.val ? JSON.parse(obj.val) : []) : [];
        var idx = homePersons.indexOf(loc.user);

        if (idx < 0 && loc.atHome) {
            homePersons.push(loc.user);
            adapter.setState('personsAtHome', JSON.stringify(homePersons), false);
        } else if (idx >= 0 && !loc.atHome) {
            homePersons.splice(idx, 1);
            adapter.setState('personsAtHome', JSON.stringify(homePersons), false);
        }
    });
}

function checkInstanceObjects() {
    var fs = require('fs'),
        io = fs.readFileSync(__dirname + "/io-package.json"),
        objs = JSON.parse(io);

    for (var i = 0; i < objs.instanceObjects.length; i++) {
        adapter.setObjectNotExists(objs.instanceObjects[i]._id, objs.instanceObjects[i]);
    }
}