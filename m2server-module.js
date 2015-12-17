// March 2013, Franziska Hinkelmann, Mike Stillman, and Lars Kastner
//
// This file defines a Node.js server for serving 'tryM2'.
//   run 
//       node m2server.js 
//   or
//       node m2server-schroot.js
// in a terminal in this directory. Alternatively you can use the Makefile 
// provided alongside this repository.
//
//
// Local version:
//
// In a browser, use: 
//      http://localhost:25151/
// Requirements:
//   Node.js libraries: cookies, connect, fs, http.  
// Install via:
//   npm install cookies, or sudo npm install -g cookies
// Required on path: M2
// We are using our own open script to make Graphs.m2 work (generate jpegs for
// users), please include the current directory in your path: 
// export PATH=.:$PATH
//
//
// Schroot version:
//
// Intended to run on (s)chrooted environment, where every user starts M2 in a
// separate schroot. For setup instructions please see configuring_ubuntu.tex.
//
//
// A message on / : possibly creates a cookie, and serves back index.html and
// related js/css/png files
// A POST message on /chat: input should be Macaulay2 commands to perform.  A
// message on /chat: start an event emitter, which will return the output of
// the M2 process.
// Image is being called by the open script to tell the server where to find a
// jpg that the user created
//

var app = require('express')();
var http = require('http').Server(app);
var fs = require('fs'),
    Cookies = require('cookies');


var M2Server = function (overrideOptions) {
    var options = {
        port: 25151, // default port number to use
        userMemoryLimit: 500000000, // Corresponds to 500M memory
        userCpuLimit: 256, // Corresponds to 256 shares of the CPU.
        // As stated wrongly on the internet this does NOT
        // correspond to 25% CPU.  The total number of shares is
        // determined as the sum of all these limits, i.e. if
        // there is only one user, he gets 100% CPU.
        PRUNECLIENTINTERVAL: 1000 * 60 * 10, // 10 minutes
        MAXAGE: 1000 * 60 * 60 * 24 * 7, // 1 week
        SCHROOT: false // if true: start with 'sudo make start' on server.
    },

        totalUsers = 0, //only used for stats: total # users since server started
        userNumber = 0, //number in the system

    // An array of Client objects.  Each has an M2 process, and a response
    // object It is possible that this.m2 is not defined, and/or that
    // this.eventStreams is not defined.
        clients = {};

    // preamble every log with the client ID
    var logClient = function (clientID, str) {
        console.log(clientID + ": " + str);
    };

    var removeSystemUser = function (clientID) {
        runShellCommand('perl-scripts/remove_user.pl ' + clients[clientID].systemUserName + ' '
        + clients[clientID].schrootName + ' ' + clients[clientID].schrootType, function (ret) {
            console.log(
                "We removed client " + clientID + " with result: " + ret);
        });
    };


    var deleteClient = function (clientID) {
        removeSystemUser(clientID);
        delete clients[clientID];
    };

    var timeBeforeInterval = function (timeInterval) {
        var now = Date.now();
        console.log("It is currently " + now + " milliseconds.");
        var minAge = now - timeInterval;
        return minAge;
    };


    var removeOldClients = function (minimalLastActiveTimeForClient) {
        for (var clientID in clients) {
            if (clients.hasOwnProperty(clientID)) {
                console.log("*** lastActivetime for user : " + clientID + " " +
                clients[clientID].lastActiveTime)
                if (clients[clientID].lastActiveTime < minimalLastActiveTimeForClient) {
                    deleteClient(clientID);
                }
            }
        }
    };

    var logCurrentlyActiveClients = function () {
        for (clientID in clients) {
            if (clients.hasOwnProperty(clientID)) {
                console.log(clientID);
            }
        }
    };

    // deciding that a user is obsolete: 
    // set clients[clientID].timestamp (set by M2 output or the client's input)
    // in set time intervals, iterate over clients and if timestamp is too old
    // or using too high resources, delete the client
    var pruneClients = function () {
        // run this when using schroot.
        // this loops through all clients, and checks their timestamp, also, it
        // checks their resource usage with a perl script. Remove old or bad
        // clients
        console.log("Pruning clients...");
        var minimalLastActiveTimeForClient = timeBeforeInterval(options.MAXAGE);
        removeOldClients(minimalLastActiveTimeForClient);
        console.log("Done pruning clients...  Continuing clients:");
        logCurrentlyActiveClients();
    };

    // runs a command, and calls the callbackFnc with the output from stdout
    var runShellCommand = function (cmd, callbackFcn) {
        console.log("Run shell command: " + cmd);
        require('child_process').exec(cmd, function (error, stdout, stderr) {
            //console.log("runShellCommand result:" + stdout);
            callbackFcn(stdout);
        });
    };

    var Client = function () {
        this.eventStreams = [];
        // generated randomly in startUser(), used for cookie and as user name
        // on the system
        this.recentlyRestarted = false;
        // we use this to keep from handling a bullet stream of restarts
        this.lastActiveTime = Date.now(); // milliseconds when client was last active
        console.log("function Client()");
    };


    // returns true if cliens[clientID] exists
    // clientID is of the form user12345
    var clientIDExists = function (clientID) {
        if (clients[clientID] == null) {
            return false;
        }
        logClient(clientID, "Client already exists");
        return true;
    };

    var getNewClientID = function () {
        do {
            var clientID = Math.random() * 1000000;
            clientID = Math.floor(clientID);
        } while (clientIDExists(clientID));
        clientID = "user" + clientID.toString(10);
        return clientID;
    };

    var setCookie = function (cookies, clientID) {
        cookies.set("tryM2", clientID, {
            httpOnly: false
        });
    };

    var setSchrootParameters = function (clientID) {
        clients[clientID].schrootType = 'system' + userNumber;
        clients[clientID].schrootName = 'system' + userNumber;
        clients[clientID].systemUserName = 'system' + userNumber;
        clients[clientID].prepend = "";
        // For now we choose all these to be equal.
        // getClientIDFromURL does not work if we choose these to be different
        // from each other.
        // There are several locations where we will have to adapt the path.
        userNumber++;
    };

    var createSystemUser = function (clientID, callbackFcn) {
        console.log("Beginning schroot user.");
        setSchrootParameters(clientID);
        runShellCommand(
            'perl-scripts/create_user.pl ' + clients[clientID].systemUserName
            + ' ' + clients[clientID].schrootType + ' '
            + options.userMemoryLimit + ' ' + options.userCpuLimit,
            function () {
                initializeSchrootEnvironment(clientID, callbackFcn);
            }
        );
    };

    var initializeSchrootEnvironment = function (clientID, callbackFcn) {
        logClient(clientID, "Spawning new schroot process named " +
        clientID + " " + clients[clientID].systemUserName + ".");
        /*
         The following command creates a schroot environment for the user.
         -c specifies the schroot type. This tells schroot to use the config file
         created by create_user.pl. The -c below at entering schroot is not the same.
         -n Sets the name of the schroot. This name will be used for the -c option
         below upon entering the schroot.
         -b is the begin flag.
         */
        require('child_process').exec(
            'sudo -u ' + clients[clientID].systemUserName + ' schroot -c '
            + clients[clientID].schrootType + ' -n ' + clients[clientID].schrootName + ' -b',
            function () {
                // write cookie to /etc/clientID, it is needed for curl in open calls
                var filename = "/usr/local/var/lib/schroot/mount/" + clients[clientID].systemUserName + "/etc/clientID";
                fs.writeFile(filename, clientID, function (err) {
                    if (err) {
                        logClient(clientID, err);
                    } else {
                        logClient(clientID, "File with clientID ie., the user cookie, was written successfully.");
                    }
                });
                callbackFcn(clientID);
            });
    };

    var startUser = function (cookies, request, callbackFcn) {
        totalUsers = totalUsers + 1;
        var clientID = getNewClientID();
        setCookie(cookies, clientID);
        clients[clientID] = new Client();
        clients[clientID].clientID = clientID;

        logClient(clientID,
            "New user: " + " UserAgent=" + request.headers['user-agent'] + ".");
        logClient(clientID, "schroot: " + options.SCHROOT);
        if (options.SCHROOT) {
            createSystemUser(clientID, callbackFcn);
        } else {
            callbackFcn(clientID);
        }
        return clientID;
    };

    var spawnSchroot = function (clientID, cmd) {
        var spawn = require('child_process').spawn;
        /*
         Starting M2 in a secure way requires several steps:
         1. cgexec adds our process to two cgroups that create_user.pl created.
         cpu:clientID restricts the CPU shares of the user
         memory:clientID restricts the memory accessible by the user
         2. schroot enters a secure chroot environment. No files from the actual
         system are available on the inside.
         -u specifies the username inside the schroot
         -c specifies the name of the schroot we want to enter
         -d specifies the directory inside the schroot we want to enter
         -r specifies the command to be run upon entering.
         */
        var setEnvironmentCommand = 'export\ PATH=$PATH:/M2/bin\;\ export\ WWWBROWSER=open-www\;\ ';
        return m2 = spawn('cgexec', [
                '-g', 'cpu,memory:' + clients[clientID].systemUserName,
                'sudo', '-u', clients[clientID].systemUserName,
                'schroot', '-c', clients[clientID].schrootName,
                '-u', clients[clientID].systemUserName,
                '-d', '/home/m2user/',
                '-r',
                '--', 'bash', '-c', setEnvironmentCommand + cmd
            ]
        );
    };

    var removeListenersFromPipe = function (clientID) {
        // the schroot might still be valid or unmounted
        return function (returnCode, signal) {
            logClient(clientID, "M2 exited.");
            logClient(clientID, "returnCode: " + returnCode);
            logClient(clientID, "signal: " + signal);
            this.stdout.removeAllListeners('data');
            this.stderr.removeAllListeners('data');
        };
    }

    var setPipeEncoding = function (process, encoding) {
        process.stdout.setEncoding(encoding);
        process.stderr.setEncoding(encoding);
    }

    var m2Start = function (clientID) {
        var spawn = require('child_process').spawn;
        if (options.SCHROOT) {
            m2 = spawnSchroot(clientID, 'M2');
        } else {
            m2 = spawn('M2');
        }
        logClient(clientID, "Spawning new M2 process...");

        m2.on('exit', removeListenersFromPipe(clientID));
        setPipeEncoding(m2, "utf8");

        return m2;
    };

    var formatServerSentEventMessage = function (data) {
        data.replace(/\n$/, "");
        return 'data: ' + data.replace(/\n/g, '\ndata: ') + "\r\n\r\n";

    };

    var sendDataToClient = function (clientID) {
        return function (data) {
            var streams = clients[clientID].eventStreams;
            updateLastActiveTime(clientID);
            message = formatServerSentEventMessage(data);
            if (!streams || streams.length == 0) { // fatal error, should not happen
                logClient(clientID, "Error: No event stream for sending data to client.");
                return;
                //throw "Error: No streams in Start M2";
            }

            for (var stream in streams) {
                //logClient(clientID, "write: " + message);
                streams[stream].write(message);
            }
        };
    };

    var attachListenersToOutputPipes = function (clientID) {
        var m2process = clients[clientID].m2;
        m2process.stdout.removeAllListeners('data');
        m2process.stderr.removeAllListeners('data');
        m2process.stdout.on('data', sendDataToClient(clientID));
        m2process.stderr.on('data', sendDataToClient(clientID));
    };

    var attachListenersToOutput = function (clientID) {
        var client = clients[clientID];
        if (!client) return;
        if (client.m2) {
            attachListenersToOutputPipes(clientID);
        }
    };

    var runFunctionIfClientExists = function (next) {
        return function (request, response) {
            var cookies = new Cookies(request, response);
            var clientID = cookies.get("tryM2");
            console.log("Client has cookie value: " + clientID);
            if (!clients[clientID]) {
                clientID = startUser(cookies, request, next(request, response));
            } else {
                next(request, response)(clientID);
            }
        };
    };

    var stats = function (request, response, next) {
        // to do: authorization
        response.writeHead(200, {
            "Content-Type": "text/html"
        });
        var currentUsers = 0;
        for (var c in clients) {
            if (clients.hasOwnProperty(c))
                currentUsers = currentUsers + 1;
        }
        response.write(
            '<head><link rel="stylesheet" href="m2.css" type="text/css" media="screen"></head>');
        response.write('<h1>Macaulay2 User Statistics</h1>');
        response.write("There are currently " + currentUsers +
        " users using M2.<br>");
        response.write("In total, there were " + totalUsers +
        " users since the server started.<br>");
        response.write("Enjoy M2!");
        response.end();
    };

    var keepEventStreamsAlive = function () {
        for (var prop in clients) {
            if (clients.hasOwnProperty(prop) && clients[prop] && clients[prop].eventStreams) {
                for (var stream in clients[prop].eventStreams) {
                    clients[prop].eventStreams[stream].write(":ping\n");
                }
            }
        }
    };

    var setEventStreamForClientID = function (clientID, stream) {
        logClient(clientID, "pushing a response");
        clients[clientID].eventStreams.push(stream);
    };

    // Client starts eventStreams to obtain M2 output and start M2
    var connectEventStreamToM2Output = function (request, response) {
        return function (clientID) {
            logClient(clientID, "connectEventStreamToM2Output");
            response.writeHead(200, {
                'Content-Type': "text/event-stream"
            });
            setEventStreamForClientID(clientID, response);

            if (!clients[clientID].m2) {
                clients[clientID].m2 = m2Start(clientID);
            }
            attachListenersToOutput(clientID);

            // If the client closes the connection, remove client from the list of active clients
            request.connection.on("end", function () {
                logClient(clientID, "event stream closed");
                response.end();
            });
        };
    };

    var m2InputAction = function (request, response) {
        return function (clientID) {
            logClient(clientID, "m2InputAction");
            if (!checkForEventStream(clientID, response)) {
                return;
            }
            ;
            request.setEncoding("utf8");
            var m2commands = "";
            // When we get a chunk of data, add it to the m2commands
            request.on("data", function (chunk) {
                m2commands += chunk;
            });

            // Send input to M2 when we have received the complete m2commands
            request.on("end", function () {
                handCommandsToM2(clientID, m2commands, response);
            });
        };
    };

    var updateLastActiveTime = function (clientID) {
        clients[clientID].lastActiveTime = Date.now();
    }

    var handCommandsToM2 = function (clientID, m2commands, response) {
        logClient(clientID, "M2 input: " + m2commands);
        if (!clients[clientID] || !clients[clientID].m2 || !clients[
                clientID].m2.stdin.writable) {
            // this user has been pruned out!  Simply return.
            response.writeHead(200);
            response.end();
            return;
        }
        updateLastActiveTime(clientID);
        try {
            clients[clientID].m2.stdin.write(m2commands, function (err) {
                if (err) {
                    logClient("write failed: " + err);
                }
            });
        } catch (err) {
            logClient(clientID, err);
            // At this point, there was some problem writing to the m2 process
            // we just return.
        }
        response.writeHead(200);
        response.end();
    };

    var ignoreRepeatedRestart = function (client) {
        logClient(clientID, "Ignore repeated restart request");
        response.writeHead(200);
        response.end();
    }


    var killM2Client = function (m2Process, clientID) {
        m2Process.kill();
        m2Process.stdin.end(); // This line is needed to remove commands stuck in
                               // the stdin pipe. Else we get 
                               // Error: read ECONNRESET
                               //    at errnoException (net.js:884:11)
                               //    at Pipe.onread (net.js:539:19)
        runShellCommand("killall -u " + clients[clientID].systemUserName, function (ret) {
            console.log(
                "We removed processes associates to " + clientID + " with result: " + ret);
        });
        logClient(clientID,
            "Killed child process with PID " + m2Process.pid);
    };

    var resetRecentlyRestarted = function (client) {
        client.recentlyRestarted = true;
        setTimeout(function () {
            client.recentlyRestarted = false;
        }, 1000);
    };

    // kill signal is sent to schroot, which results in killing M2
    var restartAction = function (request, response) {
        return function (clientID) {
            logClient(clientID, "received: /restart");
            if (!checkForEventStream(clientID, response)) {
                return;
            }

            var client = clients[clientID];

            if (client.recentlyRestarted) {
                ignoreRepeatedRestart(client);
                return;
            }

            if (client.m2) {
                killM2Client(client.m2, clientID);
            }

            resetRecentlyRestarted(client);

            client.m2 = m2Start(clientID);
            attachListenersToOutput(clientID);
            response.writeHead(200);
            response.end();
        };
    };

    var interruptAction = function (request, response) {
        return function (clientID) {
            logClient(clientID, "received: /interrupt");
            if (!checkForEventStream(clientID, response)) {
                return;
            }
            ;

            var client = clients[clientID];

            if (client && client.recentlyRestarted) {
                ignoreRepeatedRestart(client);
                return;
            }
            if (client && client.m2) {
                var m2 = client.m2;
                if (options.SCHROOT) {
                    sendInterruptToM2Process(m2.pid);
                } else {
                    m2.kill('SIGINT');
                }
            }
            response.writeHead(200);
            response.end();
        };
    };

    /* To find the actual M2 we have to dig a little deeper:
     The m2.pid is the PID of the cgexec command.
     Using pgrep we gets the child process(es).
     In this case there is only one, namely the schroot.
     The child of the schroot then is M2 which we want to interrupt.
     */
    var sendInterruptToM2Process = function (schrootPid) {
        runShellCommand('n=`pgrep -P ' + schrootPid + '`; n=`pgrep -P $n`; pgrep -P $n', function (m2Pid) {
            logClient(clientID, "PID of M2 inside schroot: " + m2Pid);
            var cmd = 'kill -s INT ' + m2Pid;
            runShellCommand(cmd, function (res) {
            });
        });
    };

    // returning clientID for a given M2 pid
    // This currently does not work when working inside a schroot, because pid
    // is not the schroot's pid
    var findClientID = function (pid) {
        //console.log("Searching for clientID whose M2 has PID " + pid);
        for (var prop in clients) {
            if (clients.hasOwnProperty(prop) && clients[prop] && clients[prop].m2) {
                if (pid == clients[prop].m2.pid) {
                    //console.log("We found the client! It is " + prop);
                    if (clients[prop].eventStreams.length != 0) {
                        //console.log("findClientID picked user with clientID " + prop);
                        return prop;
                    } else {
                        throw ("Client " + clientID +
                        " does not have an eventstream.");
                    }
                }
            }
        }
        throw ("Did not find a client for PID " + pid);
    };

    var regexMatchingForClientID = function (url) {
        // The URL's in question look like:
        //  (schroot version): /user45345/var/a.jpg
        //  (non-schroot): /dfdff/dsdsffff/fdfdsd/M2-12345-1/a.jpg
        //     where 12345 is the pid of the M2 process.
        var clientID;
        var matchobject;
        if (options.SCHROOT) {
            // This needs to be changed. What we might get here is only
            // the username. We need to match the clientID from this.
            matchobject = url.match(/^\/(user\d+)\//);
        } else {
            matchobject = url.match(/\/M2-(\d+)-/);
        }
        if (!matchobject) {
            console.log("error, could not find clientID from url");
            throw ("could not find clientID from url");
        }
        if (options.SCHROOT) {
            clientID = matchobject[1];
        } else {
            clientID = findClientID(matchobject[1]);
        }
        return clientID;
    };

    var getValidClientIDFromUrl = function (url) {
        var clientID = regexMatchingForClientID(url);
        // Sanity check:
        client = clients[clientID];
        if (!client) {
            throw ("No client for ID: " + clientID);
        }
        return clientID;
    };

    var parseUrlForPath = function (clientID, url) {
        var path = url.replace(/^\/(user)?\d+\//, "");
        if (!path) {
            throw ("Could not extract path from " + url);
        }
        if (options.SCHROOT) {
            path = "/usr/local/var/lib/schroot/mount/" + clients[clientID].schrootName + path
        }
        return path;
    };

    var forwardRequestForSpecialEventToClient = function (eventType) {
        return function (request, response) {
            var url = require('url').parse(request.url).pathname;
            response.writeHead(200);
            response.end();
            try {
                var clientID = getValidClientIDFromUrl(url);
                logClient(clientID, "Request for " + eventType + " received: " + url);
                var path = parseUrlForPath(clientID, url); // a string
                message = 'event: ' + eventType + '\r\ndata: ' + path + "\r\n\r\n";
                sendMessageToClient(clientID, message);
            } catch (err) {
                logClient(clientID, "Received invalid request: " + err);
            }
        };
    };


    var sendMessageToClient = function (clientID, message) {
        var streams = clients[clientID].eventStreams;
        if (!streams || streams.length == 0) { // fatal error, should not happen
            logClient(clientID, "Error: No event stream");
        } else {
            for (var stream in streams) {
                streams[stream].write(message);
            }
        }
    };

    var checkForEventStream = function (clientID, response) {
        if (!clients[clientID].eventStreams || clients[clientID].eventStreams.length == 0) {
            logClient(clientID, "Send notEventSourceError back to user.");
            response.writeHead(200, {
                'notEventSourceError': 'No socket for client...'
            });
            response.end();
            return false;
        }
        return true;
    };

    var unhandled = function (request, response, next) {
        var url = require('url').parse(request.url).pathname;
        console.log("Request for something we don't serve: " + request.url);
        response.writeHead(404, "Request for something we don't serve.");
        response.write("404");
        response.end();
    };

    var setOwnershipToUser = function (clientID, filename) {
        runShellCommand("chown " + clients[clientID].systemUserName + ":" + clients[clientID].systemUserName + " "
        + filename, function (e) {
            console.log("Chown: " + e);
        });
    };


    var saveUploadedFile = function (temporaryFilename, filename, clientID, response) {
        return function () {
            console.log("end received from formidable form");
            fs.rename(temporaryFilename, filename, function (error) {
                if (error) {
                    logClient(clientID, "Error in renaming file: " + error);
                    response.writeHead(500, {
                        "Content-Type": "text/html"
                    });
                    response.end('rename failed: ' + error);
                    return;
                } else {
                    if (options.SCHROOT) {
                        setOwnershipToUser(clientID, filename);
                    }
                    response.writeHead(200, {
                        "Content-Type": "text/html"
                    });
                    response.end('upload complete!');
                }
            });
        };
    };

    var sendUploadError = function (clientID) {
        return function () {
            logClient(clientID, 'received error in upload: ');
            response.writeHead(500, {
                "Content-Type": "text/html"
            });
            response.end('upload not complete!');
        };
    };


    var uploadFile = function (request, response, clientID) {
        return function (clientID) {
            logClient(clientID, "received: /uploadTutorial");
            var formidable = require('formidable');
            var form = new formidable.IncomingForm;
            var schrootPath;
            if (options.SCHROOT) {
                schrootPath = "/usr/local/var/lib/schroot/mount/" + clients[clientID].schrootName +
                "/home/m2user/";
                form.uploadDir = schrootPath;
            }

            var filename;
            var temporaryFilename;

            form.on('file', function (name, file) {
                var path;
                if (options.SCHROOT) {
                    path = schrootPath;
                } else {
                    path = "/tmp/";
                }
                filename = path + file.name;
                temporaryFilename = file.path;
                form.on('end', saveUploadedFile(temporaryFilename, filename, clientID, response));

            });


            form.on('error', sendUploadError(clientID));

            form.parse(request);
        };
    };

    var saveAction = function (request, response) {
        return function (clientID) {
            request.setEncoding("utf8");
            logClient(clientID, "received: /save");
            // Set the directory where we will write the resulting 2 files
            var path = "/tmp/";
            if (options.SCHROOT) {
                path = "/usr/local/var/lib/schroot/mount/"
                + clients[clientID].schrootName + "/home/m2user/";
            }
            ;
            var body = "";

            // When we get a chunk of data, add it to the body
            request.on("data", function (chunk) {
                body += chunk;
            });

            // grab input and output windows, place them in files where we can serve them
            request.on("end", function () {
                console.log("/save, received: " + body);
                var json = JSON.parse(body);
                console.log(json.input);

                fs.writeFile(path + "Macaulay2-input", json.input);
                fs.writeFile(path + "Macaulay2-output", json.output);
                response.writeHead(200, {
                    "Content-Type": "text/html"
                });
                var msg = {input: path + "Macaulay2-input", output: path + "Macaulay2-output"};
                response.write(JSON.stringify(msg));
                response.end();
            });
        };
    };

    var moveWelcomeTutorialToBeginning = function (tutorials, firstTutorial) {
        var index = tutorials.indexOf(firstTutorial);
        if (index > -1) {
            tutorials.splice(index, 1);
            tutorials.unshift(firstTutorial);
        }
        return tutorials;
    };

    var getListOfTutorials = function (request, response) {
        fs.readdir("public/tutorials/", function (err, files) {
            var tutorials = files.map(function (filename) {
                return "tutorials/" + filename;
            });
            console.log("Files: " + tutorials);
            response.writeHead(200, {
                "Content-Type": "text/html"
            });

            tutorials = moveWelcomeTutorialToBeginning(tutorials, "tutorials/welcome2.html");
            response.end(JSON.stringify(tutorials));
        });
    };

    var winston = require('winston'),
        expressWinston = require('express-winston');
    app.use(expressWinston.logger({
        transports: [
            new winston.transports.Console({
                json: true,
                colorize: true
            })
        ]
    }));

    var favicon = require('serve-favicon');
    app.use(favicon(__dirname + '/public/favicon.ico'));

    var serveStatic = require('serve-static');
    app.use(serveStatic('public'))
        .use('/var/folders', serveStatic('/var/folders'))
        .use('/usr/local/var/lib/schroot/mount', serveStatic('/usr/local/var/lib/schroot/mount'))
        .use('/M2', serveStatic('/M2'))
        // M2 creates temporary files (like created by Graphs.m2) here on MacOS
        .use('/tmp', serveStatic('/tmp'));
    // and here on Ubuntu

    app.use('/admin', stats)
        .use('/upload', runFunctionIfClientExists(uploadFile))
        .use('/viewHelp', forwardRequestForSpecialEventToClient("viewHelp"))
        .use('/image', forwardRequestForSpecialEventToClient("image"))
        .use('/startSourceEvent', runFunctionIfClientExists(connectEventStreamToM2Output))
        .use('/chat', runFunctionIfClientExists(m2InputAction))
        .use('/interrupt', runFunctionIfClientExists(interruptAction))
        .use('/restart', runFunctionIfClientExists(restartAction))
        .use('/save', runFunctionIfClientExists(saveAction))
        .use('/getListOfTutorials', getListOfTutorials)
        .use(unhandled);
    //.use(connect.errorHandler());

    var initializeServer = function () {
        // when run in production, work with schroots, see startM2Process()
        if (options.SCHROOT) {
            console.log('Running with schroots.');
            setInterval(pruneClients, options.PRUNECLIENTINTERVAL);
        }

        // Send a comment to the clients every 20 seconds so they don't 
        // close the connection and then reconnect
        setInterval(keepEventStreamsAlive, 20000);

        console.log("Starting M2 server.");
    };

    var listen = function () {
        console.log("M2 server listening on port " + options.port + "...");
        return http.listen(options.port);
    };

    var overrideDefaultOptions = function (overrideOptions) {
        // Start of M2Server creation code
        for (opt in overrideOptions) {
            if (options.hasOwnProperty(opt)) {
                options[opt] = overrideOptions[opt];
                console.log("m2server option: " + opt + " set to " + options[opt]);
            }
        }
    };

    process.on('uncaughtException', function (err) {
        console.log('Caught exception in global process object: ' + err);
    });


    overrideDefaultOptions(overrideOptions);
    initializeServer();


    // These are the methods available from the outside:
    return {
        server: http,
        listen: listen,
        close: function () {
            http.close();
        }
    };
}; // end of def of M2Server

//var m2server = M2Server();
//m2server.listen(25151);
exports.M2Server = M2Server;

// Local Variables:
// indent-tabs-mode: nil
// tab-width: 4
// End:
