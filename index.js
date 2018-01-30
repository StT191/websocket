"use strict";


// msg receiving helpers
function byteSlice(byte, start, stop) {
    return (byte >>> (8-stop)) & ((1 << (stop-start)) - 1);
}

function bit(byte, pos) {
    return (byte >>> (7-pos)) & 1;
}



// client resources
const EventEmitter = require("events");
const validUTF8 = require("./lib/validUTF8");

const maxFrame = 281474976710655; // max 48 bit
const defaultMaxMessage = 134217728; // 128 MiB
const defaultTimeout = 5000; // 5 sec



// websocket client
function WebSocket(socket, server=false, settings={}) {
    const client = this;

    client.socket = socket;

    client.server = server;
    client.request = null; // may be overwritten
    client.response = null; // may be overwritten
    client.protocol = ""; // may be overwritten

    client.maxMessage = settings.maxMessage || defaultMaxMessage;
    client.timeout = settings.timeout || defaultTimeout;
    client.validateUTF8 = settings.validateUTF8 || false;

    client.mask = (server) ? 0 : 1; // sets masking bit at each send

    socket.allowHalfOpen = false;

    socket.on("error", error=>client.emit("error", error));
    socket.once("close", function (had_error) {
        client.state = 4; // closed
        client.closed = true;
        clearTimeout(socket.closeTimer);
        message = null; // free some ram
        frame = null;
        head = null;
        socket.removeAllListeners();
        client.statusCode = client.statusCode || 1006;
        client.emit("close", client.statusCode, had_error || client.closeReason);
        client.removeAllListeners();
    });


    client.on("error", e=>{}); // prevents crashing if unhandled

    client.state = 1; // connected
    client.closed = false;


    // fragmented message
    var message = [];
    message.size = 0;

    // fragmented frame
    var frame = [];

    // fragmented head
    var head = [];
    head.need = 2; // need at least 2 bytes to read the head of the message
    head.size = 0;


    socket.on("data", function (data) {
        if (!frame.outstanding) {
            head.push(data);
            head.size += data.length;
            if (head.size >= head.need) onFrameHead(Buffer.concat(head, head.size));
        }
        else onOutstanding(data);
    });


    function onFrameHead(data) {
        if (client.state >= 3) return; // should never occour

        const mask = bit(data[1], 0);
        if (mask !== client.mask^1) return recvError(client, "mask");

        const RSV = byteSlice(data[0], 1, 4);
        if (RSV !== 0) return recvError(client, "RSV");

        const FIN = bit(data[0], 0);
        const opcode = byteSlice(data[0], 4, 8);

        switch(opcode) {
            case 0: if (!message.length) return recvError(client, "fragmentation", opcode); break;
            case 1: case 2: if (message.length) return recvError(client, "fragmentation", opcode); break;
            case 8: case 9: case 10: if (!FIN) return recvError(client, "FIN", opcode); break;
            default: return recvError(client, "opcode", opcode); break;
        }

        const initLength = byteSlice(data[1], 1, 8);

        var length, lbl; // last byte of length field
        if (initLength <= 125) { lbl = 2; length = initLength; }
        else if (initLength === 126) { lbl = 4; length = data.readUInt16BE(2, true); }
        else if (initLength === 127) { lbl = 10; length = data.readUIntBE(4, 6, true); }

        const dataLength = data.length;
        const headSize = lbl + 4*mask;

        // check if header is complete
        if (dataLength < headSize) {
            head = [data];
            head.need = headSize;
            head.size = dataLength;
            return;
        } else {
            head = []; head.need = 2; head.size = 0;
        }

        if (lbl === 10 && data.readUInt16BE(2, true) !== 0) return recvError(client, "frame");

        switch(opcode) {
            case 0: if ((message.size + length) > client.maxMessage) return recvError(client, "length", client.maxMessage); break;
            case 1: case 2: if (length > client.maxMessage) return recvError(client, "length", client.maxMessage); break;
            case 8: case 9: case 10: if (length > 125) return recvError(client, "payload", opcode); break;
        }

        frame.FIN = FIN;
        frame.opcode = opcode;
        frame.key = (mask) ? data.slice(lbl, lbl + 4) : null;
        frame.outstanding = length;
        frame.size = length;

        onOutstanding(data.slice(headSize));
    }


    function onOutstanding(data) {
        const take = Math.min(data.length, frame.outstanding);
        const chunk = data.slice(0, take);

        const key = frame.key;
        if (key) {
            let n, i = frame.size - frame.outstanding;
            for (n=0; n<take; n++, i++) chunk[n] ^= key[i%4];
        }

        frame.outstanding -= take;
        frame.push(chunk);

        if (!frame.outstanding) {
            const FIN = frame.FIN;
            const opcode = frame.opcode;
            const load = Buffer.concat(frame, frame.size);
            frame = [];

            switch(opcode) {
                case 0: /* "continue" */ case 1: /* "text" */ case 2: // "binary"
                    if (opcode===1) message.text = true;
                    //if (message.text && client.validateUTF8 && !validUTF8(load)) return recvError(client, "utf8");
                    message.push(load);
                    message.size += load.length;
                    if (FIN) {
                        let Message = Buffer.concat(message, message.size);
                        if (message.text && client.validateUTF8 && !validUTF8(Message)) return recvError(client, "utf8");
                        if (message.text) Message = Message.toString();
                        message = [];
                        message.size = 0;
                        client.emit("message", Message);
                    }
                    break;

                case 8: // "end"
                    let statusCode;
                    if (!load.length) {
                        statusCode = 1000;
                        client.statusCode = client.statusCode || 1005;
                    }
                    else {
                        statusCode = load.readUInt16BE(0, true);
                        if ( ![1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011]
                            .includes(statusCode) && !(2999 < statusCode && statusCode < 5000)
                        ) statusCode = 1002;
                        client.statusCode = client.statusCode || statusCode;
                    }

                    let closeReason = load.slice(2);
                    if (!validUTF8(closeReason)) {
                        closeReason = "";
                        statusCode = 1002;
                    }
                    client.closeReason = closeReason.toString();

                    if (client.state === 1) client.close(client.closeReason, statusCode);
                    client.state = 3;
                    socket.end();
                    socket.removeAllListeners("data");
                    timeout(client);
                    break;

                case 9: // "ping"
                    socket.write(Frame(load, 1, 0, 10, client.mask)); // single send_frame here
                    break;

                case 10: // "pong"
                    client.emit("pong", load);
                    break;
            }

            // if there is still data left start parsing a new head
            if (data.length - take > 0) onFrameHead(data.slice(take));
        }
    }
}



// receiving error funcion
function recvError(client, type, spec) { // errors close the client connection
    const e = {
        "payload": [{8:"end",9:"ping",10:"pong"}[spec]+" payload exceeds 125 bytes", 1002],
        "length": ["message length exceeds "+spec+" bytes", 1009],
        "frame": ["frame length exceeds "+maxFrame+" bytes", 1009],
        "mask": ["bad masking bit", 1002],
        "RSV": ["bad RSV bits", 1002],
        "fragmentation": ["bad frame fragmentation, opcode: "+spec, 1002],
        "opcode": ["bad opcode: "+spec, 1002],
        "FIN": ["bad FIN bit with opcode "+spec, 1002],
        "utf8": ["invalid utf8", 1007]
        // "statusCode": ["invalid statusCode code: "+spec, 1002]
    }[type];

    client.close(e[0], e[1]); // only if close wasn't called before

    const error = new Error(e[0]);
    Object.assign(error, {code: e[1], type});

    client.emit("error", error);
    return false;
}



// sending error funcion
function sendError(type, spec) {
    const error = new Error({
        "ping": "ping payload exceeds 125 bytes",
        "close": "close payload exceeds 123 bytes + status code",
        "frame": "frame limit is "+spec+" bytes as of rigth now ;)",
        "closed": "connection was closed"
    }[type]);
    error.code = "ESEND";
    throw error;
    return false;
}



function timeout(client) {
    clearTimeout(client.socket.closeTimer);
    client.socket.closeTimer = setTimeout(
        () => !client.socket.destroyed && client.socket.destroy("closeTimeout"),
        client.timeout
    );
}



// send rescources
const crypto = require("crypto");
const fragSize = 65535; // 65KiB - 1 bit = fragment size



// frame funcion
function Frame(data=Buffer.allocUnsafe(0), FIN=1, RSV=0, opcode=1, mask=1) {
    const parts = [Buffer.allocUnsafe(2)];
    parts[0][0] = 128*FIN + 16*RSV + opcode;

    const length = data.length;

    if (length <= 125)
        parts[0][1] = 128*mask + length;

    else if (length <= 65535) {
        parts[0][1] = 128*mask + 126;
        parts.push(Buffer.allocUnsafe(2));
        parts[1].writeUInt16BE(length);
    }
    else if (length <= maxFrame) {
        parts[0][1] = 128*mask + 127;
        parts.push(Buffer.alloc(8));
        parts[1].writeUIntBE(length, 2, 6);
    }
    else return sendError("frame", maxFrame); // !!!

    if (mask) {
        const key = crypto.randomBytes(4);
        const masked = Buffer.allocUnsafe(length);
        let i;
        for (i=0; i<length; i++) masked[i] = data[i] ^ key[i%4];
        parts.push(key);
        parts.push(masked);
    }
    else parts.push(data);

    return Buffer.concat(parts);
}



function messagerize(data=Buffer.allocUnsafe(0)) {
    switch(data.constructor) {
        case Buffer:
            data.opcode = 2;
            return data; break;
        case ArrayBuffer:
            data = Buffer.from(data);
            data.opcode = 2;
            return data; break;
        case String:
            data = Buffer.from(data);
            data.opcode = 1;
            return data; break;
        default:
            data = Buffer.from(JSON.stringify(data));
            data.opcode = 1;
            return data; break;
    }
}



// WebSocket methods and EventEmitter
Object.assign(WebSocket.prototype, EventEmitter.prototype, {

    send: function (data, cb) { // cb returns on socket write
        if (this.closed) sendError("closed");
        data = messagerize(data);

        if (data.length <= fragSize)
            return this.socket.write(Frame(data, 1, 0, data.opcode, this.mask), cb);
        else {
            const frames = Math.floor(data.length / fragSize);

            let drain;
            for (let i=0; i<=frames; i++) {
                const FIN = (i === frames) ? 1 : 0;
                const opcode = (i === 0) ? data.opcode : 0;
                const callb = (i === frames) ? cb : undefined;
                drain = this.socket.write(Frame( data.slice(i*fragSize, (i+1)*fragSize),
                    FIN, 0, opcode, this.mask), callb);

            }
            return drain;
        }
    },

    ping: function (data="", onPong, cb) { // cb returns on socket write
        if (this.closed) return sendError("closed");
        if (data.length > 125) return sendError("ping");

        if (onPong) this.once("pong", onPong);
        return this.socket.write(Frame(messagerize(data), 1, 0, 9, this.mask), cb);
    },

    close: function (data="", statusCode=1000) {
        if (this.state === 1) {
            if (data.length > 123) return sendError("close");

            const codeBuffer = Buffer.allocUnsafe(2);
            codeBuffer.writeUInt16BE(statusCode);

            this.socket.write(Frame( Buffer.concat([codeBuffer, messagerize(data)]),
                1, 0, 8, this.mask));
            this.statusCode = statusCode;

            if (statusCode === 1000) {
                this.state = 2; // closing

                this.socket.closeTimer = setTimeout(
                    () => {this.socket.end(); timeout(this);},
                    this.timeout
                );
            }
            else {
                this.state = 3; // like close received
                this.socket.end();
                this.socket.removeAllListeners("data");
                timeout(this);
            }

            return true;
        }
        else return false;
    }

});





// server resources
function sha1(data) {
    const hash = crypto.createHash("sha1");
    hash.update(data);
    return hash.digest("base64");
}

const url_parse = require("url").parse;
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";




// websocket server (pass to "upgrade" listener of a http server)
function WebSocketServer(settings={}, onConnect=null) {
    if (typeof settings === "function") {
        onConnect = settings;
        settings = {}; // protocol, accept, timeout, maxMessage
    }


    function server(request, socket, head) {
        if (server.closed) return;

        request.url = url_parse(request.url, true);
        const headers = request.headers;
        const settings = server.settings;
        var key;

        let protos, protocol, protoHeader = "";

        if (settings.protocol && (protos = headers["sec-websocket-protocol"])) {
            protocol = protos.split(", ").find(p=>settings.protocol.includes(p));
            if (protocol) protoHeader = "Sec-WebSocket-Protocol: "+protocol+"\r\n";
        }
                            // !! no host field is required -> no strict standard compliance
        if (
            (!settings.path || request.url.pathname === settings.path) &&
            headers["upgrade"].toLowerCase() === "websocket" &&
            (key = headers["sec-websocket-key"]) &&
            Buffer.from(key, "base64").length === 16 &&
            headers["sec-websocket-version"] === "13" &&
            headers["connection"] &&
            headers["connection"].includes("Upgrade") &&
            (!settings.accept || settings.accept(request, protocol))
        ) {
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n"
                +"Date: "+new Date().toUTCString()+"\r\nUpgrade: websocket\r\n"
                +"Sec-WebSocket-Accept: "+sha1(key+wsGUID)+"\r\n"+protoHeader+"\r\n"
            );

            socket.server = socket._server = null;
            socket.removeAllListeners("timeout");
            socket.setTimeout(0);

            const client = new WebSocket(socket, server, settings);

            client.request = request;
            client.protocol = protocol;

            socket.once("close", () =>{
                server.clients.delete(client);
                if (server.closed && !server.clients.size) server.emit("close");
            });

            socket._events.close.reverse(); // the preceding calls first

            client.on("message", msg=>server.emit("message", msg, client));
            client.on("pong", data=>server.emit("pong", data, client));
            client.on("error", error=>server.emit("error", error, client));
            client.once("close", (code, reason)=>server.emit("clientClose", code, reason, client));

            server.clients.add(client);
            server.emit("connect", client);
            if (head.length) socket.emit("data", head);
        }

        else socket.end("HTTP/1.1 400 Bad Request\r\nDate: "+new Date().toUTCString()+"\r\n\r\n");
    }

    Object.assign(server, WebSocketServer.prototype);
    server.constructor = WebSocketServer;

    server.settings = settings;
    server.clients = new Set([]);

    // server.on("error", e=>{}); // ???? prevents blocking if unhandled

    if (onConnect) server.on("connect", onConnect);

    return server;
}


// WebSocket Server methods and EventEmitter
Object.assign(WebSocketServer.prototype, EventEmitter.prototype, {

    broadcast: function (data, excludeClient) {
        this.clients.forEach(cl=>cl.state===1 && cl!==excludeClient && cl.send(data));
    },

    disconnect: function (data, code) {
        this.clients.forEach(cl=>cl.state===1 && cl.close(data, code));
    },

    open: function (data, code) {
        this.closed = false;
    },

    close: function (data, code) {
        this.closed = true;
    }

});



// websocket server already integrated with http server, ready to listen
function createServer(settings={}, onConnect=null) {
    if (typeof settings === "function") {
        onConnect = settings;
        settings = {}; // protocol, accept, timeout, maxMessage
    }

    const tls = settings.tls;
    delete settings.tls;

    // go

    const wsServer = WebSocketServer(settings, onConnect);

    const httpServer = (tls ? require("https") : require("http")).createServer(tls);

    httpServer.on("upgrade", wsServer);
    httpServer.timeout = 0;
    httpServer.on("error", error=>wsServer.emit("error", error)); // handle errors !!!
    wsServer[tls ? "https" : "http"] = httpServer;

    wsServer.listen = (...args) => {
        wsServer.open();
        httpServer.listen(...args);
        return wsServer;
    }
    wsServer.close = () => {
        httpServer.close();
        WebSocketServer.prototype.close.call(wsServer);
    }

    return wsServer;
}




// establish client connection to a remote server
function connect(url, settings={}, callback) {
    if (typeof settings === "function") {
        callback = settings;
        settings = {}; // protocol, headers, auth, timeout, maxMessage
    }

    const key = crypto.randomBytes(16).toString("base64");

    url = url_parse(url);

    const [get, protocol] = {
        "ws:": [require("http").get, "http:"],
        "wss:": [require("https").get, "https:"]
    }[url.protocol];

    const headers = Object.assign(settings.headers || {}, {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": 13
    });

    if (settings.protocol) headers["Sec-WebSocket-Protocol"] = settings.protocol.join(", ");

    // send request
    const request = get(Object.assign(url, {headers, protocol, agent: false, auth: settings.auth}));


    // manage event callbacks and timeout
    var once = false;

    const abortTimer = setTimeout(
        ()=>callB(null, "timeout"),
        settings.timeout || defaultTimeout
    );


    function callB(client, error, response) {
        if (once) return;
        once = true;

        clearTimeout(abortTimer);

        if (error) {
            if (typeof error === "string") {
                error = new Error(error);
                error.code = "ECONNECT";
                error.response = response;
            }
            request.abort();
            callback(null, error);
        }
        else {
            request.removeAllListeners();
            callback(client);
        }
    }


    // Events
    request.once("response", r=>callB(null, r.statusCode+" "+r.statusMessage) );
    request.once("error", e=>callB(null, e) );


    const match = sha1(key+wsGUID);

    request.once("upgrade", function(response, socket, head) {
        clearTimeout(abortTimer);

        const headers = response.headers;
        var protocol;

        if (
            response.statusCode === 101 &&
            headers["upgrade"].toLowerCase() === "websocket" &&
            headers["connection"] &&
            headers["connection"].includes("Upgrade") &&
            headers["sec-websocket-accept"] === match &&
            !headers["sec-websocket-extensions"] &&
            ( !(protocol = headers["sec-websocket-protocol"]) ||
                settings.protocol && settings.protocol.includes(protocol) )
        ) {
            delete socket._httpMessage;

            const client = new WebSocket(socket, null, settings);

            client.request = request;
            client.response = response;
            client.protocol = protocol;

            client.once("connect", callB);
            client.emit("connect", client);
            if (head.length) socket.emit("data", head);
        }
        else {
            const client = new WebSocket(socket, null);
            client.close("bad upgrade", 1002);
            callB(null, "bad upgrade", response);
        }
    });
}




// exports
module.exports = {connect, createServer, Server: WebSocketServer, Socket: WebSocket, Frame};
