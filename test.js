#!/usr/bin/env node
"use strict";

// assert
const assert = require("assert");


// setup
const ws = require("stt-websocket");

function createServer(self) {
    self.server = ws.createServer(self, undefined);
}

function listen(self, port, cb) {
    self.server.listen(port, cb);
}

function connect(self, port, cb) {
    ws.connect("ws://127.0.0.1:"+port+(self.path||"")+(self.search||""),
        self, (cl, err)=>{self.client=cl; self.error=err; cb();});
}

function clientSetup(self, port, cb) {
    createServer(self);
    listen(self, port, ()=>connect(self, port, ()=>cb(self.client)));
}

function serverSetup(self, port, cb) {
    createServer(self);
    listen(self, port, ()=>connect(self, port, ()=>cb(self.serverClient)));
    self.server.on("connect", cl=>{self.serverClient=cl;});
}

function cleanup(self, cb) {
    self.server.close();
    self.server.disconnect();
    cb();
}

var ports = 2300;


// tests
const tests = {

    "server basic setup": function (cb) {
        const self = {}; createServer(self); const port = ++ports;


        assert(self.server.constructor === ws.Server, "server is not a WebSocketServer");
        assert(self.server.http instanceof require("http").Server, "httpServer is not a HttpServer");


        cleanup(self, cb);
    },

    "server listening in time": function (cb) {
        const self = {}; createServer(self); const port = ++ports;
        var gotback = false;
        function finish() {if (!gotback) {gotback = true; cleanup(self, cb);}}


        listen(self, port, finish);
        assert(self.server.http.listening, "server is not listening");
        var tm = setTimeout(function () {
            assert(gotback, "listening callback takes too long");


            finish();
        }, 100);
    },

    "client connects to server": function (cb) {
        const self = {}; createServer(self); const port = ++ports;
        listen(self, port, function () {
            connect(self, port, ()=>{});


            setTimeout(function () {
                assert(!self.error, "connect error occured, or timeout");
                assert(self.client instanceof ws.Socket, "client is not a WebSocket, or timeout");


                cleanup(self, cb);
            }, 100);
        });
    },

    "server receives connection": function (cb) {
        const self = {}; const port = ++ports;
        createServer(self);
        self.server.on("connect", cl=>{self.serverClient=cl;});
        listen(self, port, function () {
            connect({}, port, ()=>{});


            setTimeout(function () {
                assert(self.serverClient instanceof ws.Socket, "serverClient is not a WebSocket, or timeout");


                cleanup(self, cb);
            }, 100);
        });
    },

    "server accept, path, protocol, client headers, auth": function (cb) {
        const port = ++ports;
        var auth;

        const self = {
            headers: {"User": "testUser"},
            auth: "testUser:testPassword",
            path: "/testting",
            search: "?reallyTesting",
            protocol: ["proto1", "proto2", "proto3"],
            accept: (request, protocol)=>(
                protocol === "proto1" && request.url.search === self.search &&
                request.headers.user === "testUser" &&
                (auth = request.headers.authorization) &&
                auth.slice(6) === Buffer.from("testUser:testPassword").toString("base64")
            )
        };
        serverSetup(self, port, function (serverClient) {
            assert(serverClient instanceof ws.Socket, "server didn't accept");
            assert(serverClient.protocol === "proto1", "server didn't choose proto1");
            // console.log(serverClient.request.headers);


            cleanup(self, cb);
        });
    },

    "client ping -> pong": function (cb) {
        const self = {}; const port = ++ports;
        clientSetup(self, port, function (client) {


            var ping = false;
            client.on("pong", ()=>{ping=true});
            client.ping("");
            setTimeout(function () {
                assert(ping, "no ping");


                cleanup(self, cb);
            }, 1000);
        });
    },

    "server ping -> pong": function (cb) {
        const self = {}; const port = ++ports;
        serverSetup(self, port, function (serverClient) {


            var ping = false;
            serverClient.on("pong", ()=>{ping=true});
            serverClient.ping("");
            setTimeout(function () {
                assert(ping, "no ping");


                cleanup(self, cb);
            }, 1000);
        });
    },

    "client echo text and binary": function (cb) {
        const self = {}; const port = ++ports;
        clientSetup(self, port, function (client) {
            self.server.on("message", (msg,cl)=>cl.send(msg));


            var msgText = "";
            var msgBinary = "";
            client.on("message", (msg)=>{
                if (typeof msg === "string") msgText = msg;
                else msgBinary = msg.toString();
            });
            client.send("hallo");
            client.send(Buffer.from("halloBuffer"));
            setTimeout(function () {
                assert(msgText === "hallo", "not echoing text");
                assert(msgBinary === "halloBuffer", "not echoing binary");


                cleanup(self, cb);
            }, 1000);
        });
    },

    "server echo text and binary": function (cb) {
        const self = {}; const port = ++ports;
        serverSetup(self, port, function (serverClient) {
            self.client.on("message", (msg)=>self.client.send(msg));


            var msgText = "";
            var msgBinary = "";
            serverClient.on("message", (msg)=>{
                if (typeof msg === "string") msgText = msg;
                else msgBinary = msg.toString();
            });
            serverClient.send("hallo");
            serverClient.send(Buffer.from("halloBuffer"));
            setTimeout(function () {
                assert(msgText === "hallo", "not echoing text");
                assert(msgBinary === "halloBuffer", "not echoing binary");


                cleanup(self, cb);
            }, 1000);
        });
    },

    "server sent to big a message": function (cb) {
        const self = {}; const port = ++ports;
        serverSetup(self, port, function (serverClient) {

            serverClient.on("close", function (code, msg) {
                self.close = {code, msg};
            });
            serverClient.send(Buffer.allocUnsafe(129*1024*1024));
            setTimeout(function () {
                assert(self.close.code === 1009, "a message too large got through or didn't arrive yet");

                cleanup(self, cb);
            }, 1000);
        });
    }
}


Object.entries(tests).forEach(function ([name, test], index) {
    test(()=>console.log("done", (index+1)+":", name));
});
