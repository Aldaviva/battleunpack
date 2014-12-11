var _              = require('lodash');
var emailAddresses = require('email-addresses');
var eventStream    = require('event-stream');
var JSONStream     = require('JSONStream');
var prompt         = require('prompt');
var Q              = require('q');
var request        = require('request');

var DEFAULT_HEADERS = {
    "X-Bundle-Version": "243",
    "X-App-Version": "2.0.0",
    "User-Agent": "Mozilla/5.0 (Linux; Android 4.4.4; Nexus 7 Build/KTU84P) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/33.0.0.0 Safari/537.36 BattlelogMobile/2.5.0 (Language: en; Capabilities: scanQRCode; Dimensions: 1200x1824; Density: 2.0; )",
    "Origin": "file://",
    "X-Requested-With": "com.ea.bf3bl.inc",
    "Accept-Language": "en-US"
};

var auth = {};
var cookieJar = request.jar();

function main(){
    Q.try(getCredentials)
        .then(logIn)
        .then(listUnopenedBattlepacks)
        .then(openBattlepacks)
        .then(reportResults)
        .fail(function(err){
            console.error("Unable to open battlepacks:", err.message);
            console.error();
        });
}

main();


/**
 * @return promise for credentials object: { username: "foo@bar.com", password: "1234" }
 */
function getCredentials(){
    return Q.promise(function(resolve, reject){
        var promptParams = [{
            name: 'email',
            description: "Origin Account e-mail:",
            message: "Invalid e-mail address",
            required: true,
            conform: function(rawValue){
                return null !== emailAddresses.parseOneAddress(rawValue);
            }
        },{
            name: 'password',
            description: "Password:",
            message: "Password required",
            required: true,
            hidden: true
        }];

        prompt.message = prompt.delimiter = "";
        prompt.colors = false;
        prompt.start();

        prompt.get(promptParams, function(err, results){
            if(err){
                console.error(err);
                reject(err);
            } else {
                resolve(results);
            }
        });
    });
}

/**
 * @param credentials object
 *
 * @return promise for auth object: { sessionId: "w2m9", personaId: "2741" }
 * Also sets the global auth object with the return value.
 * The global cookieJar will have the beaker.session.id cookie set.
 */
function logIn(credentials){
    return Q.promise(function(resolve, reject){
        request({
            url: "https://battlelog.battlefield.com/mobile/gettoken",
            method: "POST",
            form: {
                email: credentials.email,
                password: credentials.password,
                clientId: "",
                pushId: "", //hopefully this isn't needed
                bundleId: "com.ea.bf3bl.inc",
                bundleVersion: "243",
                deviceName: "Nexus7",
                deviceLanguage: "en",
                deviceTimezone: "8",
                deviceType: "1",
                deviceOS: "2",
                timestamp: new Date().getTime()
            },
            json: true,
            headers: DEFAULT_HEADERS,
            jar: cookieJar
        }, function(err, res, body){
            if(err){
                reject(err);
            } else {
                if(body.success === 0){
                    reject(new Error(body.error));
                } else {
                    _.extend(auth, {
                        sessionId: body.data.sessionKey,
                        personaId: body.data.activePersonas["2048"].personaId
                    });
                    resolve(auth);
                }
            }
        });
    })
    .fail(function(err){
        console.error("The e-mail or password you entered is invalid.");
        process.nextTick(main);
        throw new Error("invalid-login");
    });
}

/**
 * @return promise for an array of battlepack objects: [{ packId: "6227" }]
 * Only battlepacks that have not been opened will be returned.
 * This is a projected view of a battlepack object where most fields have been omitted.
 */
function listUnopenedBattlepacks(){
    var deferred = Q.defer();

    request({
        url: "https://battlelog.battlefield.com/bf4/mobile/getbattlepacks",
        headers: _.extend({
            "X-Session-Id": auth.sessionId
        }, DEFAULT_HEADERS),
        jar: cookieJar,
        form: {
            game: "2048",
            personaId: auth.personaId,
            platform: "64",
            timestamp: new Date().getTime()
        }
    }).pipe(JSONStream.parse("data.packs", function(pack){
        return (pack.openedAt === 0)
            ? { packId: pack.packId }
            : null;
    })).pipe(eventStream.writeArray(deferred.makeNodeResolver()));

    return deferred.promise;
}

/**
 * Opens the given battlepacks
 * @param battlepacks array of battlepack objects, all of which should be unopened
 * @return list of battlepack object promises, which have a state and a value or reason (depending on whether their state is fulfilled or rejected)
 */
function openBattlepacks(unopenedBattlepacks){
    if(unopenedBattlepacks.length){
        console.info("Opening "+unopenedBattlepacks+" battlepacks...");
    } else {
        console.info("All of your battlepacks are already open.");
        return [];
    }

    return Q.allSettled(unopenedBattlepacks.map(function(battlepack){
        return Q.promise(function(resolve, reject){
            request({
                url: "https://battlelog.battlefield.com/bf4/mobile/openbattlepack",
                method: "POST",
                headers: _.extend({
                    "X-Session-Id": auth.sessionId
                }, DEFAULT_HEADERS),
                jar: cookieJar,
                form: {
                    game: "2048",
                    personaId: auth.personaId,
                    platform: "64",
                    packId: battlepack.packId,
                    timestamp: new Date().getTime()
                }
            })
            .on('error', function(err){
                reject({
                    battlepack: battlepack,
                    err: err
                });
            })
            .on('response', function(res){
                if(res.statusCode === 200){
                    resolve(battlepack);
                } else {
                    reject({
                        battlepack: battlepack,
                        statusCode: res.statusCode
                    });
                }
            });
        });
    }));
}

/**
 * Print out overall results.
 * @param battlepacks list of battlepack objects after being opened
 */
function reportResults(battlepackOpenResults){
    var openResultsGroupedByState = _.groupBy(battlepackOpenResults, "state");

    if(openResultsGroupedByState["fulfilled"]){
        console.info(openResultsGroupedByState["fulfilled"].length + " battlepacks opened successfully.");
    }

    if(openResultsGroupedByState["rejected"]){
        console.error(openResultsGroupedByState["rejected"].length+" battlepacks failed to open.");
    }
}