

#### connect(url, callback[, settings])

* `url` _\<string>_
    e.g. `"ws://my-websocket.com/chat"` or `"wss://secure-websocket.com/login"`
* `callback(client, error)` _\<function>_
    will be called on connection or in case of error
    * `client` _\<WebSocket>_ will be `null` in case of error
    * `error` _\<Error>_ only in case of error, `error.code = "ECONNECT"`, client will be `null`
* `settings` _\<Object>_
    * `maxMessage` _\<number>_ disconnect on receiving a message bigger than `maxMessage` (in bytes),
      default is `134217728` (128 MiB)
    * `validateUTF8` _\<boolean>_ enable utf8-validation, default is `false`
    * `timeout` _\<number>_  close pending connect or enforce pending close after timeout (in ms),
      default is `5000` (5 sec)
    * `protocol` _\<string[ ]>_ a list of sub-protocols for handshake
    * `headers` _\<Object>_ a list of optional headers to be sent to the server
    * `auth` _\<string>_ Basic authentication i.e. `"user:password"` to compute an Authorization header
