var sys = require('sys'),
    events = require('events'),
    com = require("serialport");

/*
 * Constructor
 */
 
function Rfidgeek(options) {
  // default options
  options = options || {};
  this.websocket      = options.websocket ;
  this.portname       = options.portname  || '/dev/ttyUSB0' ;
  this.tagtype        = options.tagtype   || 'ISO15693' ;
  this.scaninterval   = options.scaninterval   || 1000 ;
  this.readerconfig   = options.readerconfig   || './univelop_500b.json' ;
  this.length_to_read = options.length_to_read || 8 ;
  this.bytes_per_read = options.bytes_per_read || 1 ;

  logger = require('./logger');
  logger.debugLevel = options.debug || 'none' ;

  if(false === (this instanceof Rfidgeek)) {
      return new Rfidgeek(options);
  }
  
  events.EventEmitter.call(this);
}

// Make Rfidgeek inherit EventEmitter - ability to create custom events on the fly 
sys.inherits(Rfidgeek, events.EventEmitter);

/*
 * exported init function
 */
 
Rfidgeek.prototype.init = function() {
  var self = this;

  if(self.websocket) {                    // websocket boolean
    var wss = require("./wsserver.js");   // websocket server - pushes to connected clients
    var ws = require("./wsclient.js");    // websocket client - sends rfid result to server
    ws.connect('ws://localhost:8080/ws');
  
    // grab websocket handle when ready
    ws.on('ready', function(connection) {
      socket = connection;
    });
  }
  
  // read reader config file
  var readerConfig = require(self.readerconfig);
  
  // data variables
  var tagData = ''; // this stores the tag data
  var readData = '';  // this stores the read buffer
  var start_offset = 0;
  var offset = start_offset;
          
  // Create new serialport pointer
  var reader = new com.SerialPort(self.portname , { 
    baudRate: 115200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: false,
    buffersize: 1024
  }, true); // this is the openImmediately flag [default is true]
  
 
  /* Workflow:
    Reader gets 'open' event, runs:
    * emit initialize event
    * turns on the scan loop
    * gets tag data, quits scan loop, activates read tag loop
    * read tag loop completed, reactivated scan loop
  */
  
  // EVENT LISTENERS
  
  reader.on('open',function() {
    logger.log('info', 'Port open');
    
    reader.on('initialize', initialize);
    reader.on('initcodes', initcodes);
    reader.on('scanloop', self.scanTagLoop);
    reader.on('readtag', readTag);
    reader.on('rfiddata', rfidData);
    reader.on('readtagdata', readTagData);
    
    // unregister tag if removed
    reader.on('tagremoved', function() {
      logger.log('info', 'Tag removed');
      if (self.websocket) {
        socket.sendUTF("Tag removed");
      }
      tagData = '';
    });
    
    // register new tag and 
    // start readloop if ISO15693 tag, else ignore
    reader.on('tagfound', function( tag ) {
      if (tag != tagData) {                     // do nothing unless new tag is found
        logger.log('info', "New tag found!");
        if (self.websocket) {
          socket.sendUTF(tag);
        }
        self.emit('tagfound', tag);             // emit to calling external app!
        tagData = tag;                          // register new tag
        if (self.tagtype == 'ISO15693') {       // if ISO15693 tag:
          stopScan();                           // stop scanning for tags
          readTag(tag);                         // start read loop
        }
      } else {
        logger.log('info', "same tag still...");
      }
    });
  
    reader.on('rfidresult', function(data) {
      logger.log('info', "Full tag received: "+data);
      if (self.websocket) {
        socket.sendUTF(data.substring(1));       // send to websockets, skip first byte
      }
      self.emit('rfiddata', data.substring(1));  // emit to external app
    });
    
    reader.on('data', gotData);
    
    reader.emit('initialize', readerConfig.initialize['init']);
    reader.emit('scanloop', readerConfig.protocols[self.tagtype]);
  });
  
  // error
  reader.on('error', function( msg ) {
    logger.log('error', msg );
  });
  
  // close
  reader.on('close', function ( err ) {
    logger.log('info', 'port closed');
  });
  
  // FUNCTIONS
  
  // initialize reader and emit initcodes event
  var initialize = function(cmd, callback) {
    reader.write(cmd, function(err) {
      if (err){ callback(err)}
      else {
        logger.log('info', 'initialized reader...')
        // initialized? emit initcodes
        reader.emit('initcodes', readerConfig.protocols[self.tagtype]['initcodes']);
      }
    });
  }
  
  // run initcodes (before each tag loop)
  var initcodes = function(cmd, callback) {
    reader.write(cmd['register_write_request'], function(err,cb) {
      if (err){ callback(err)}
      else { 
        reader.write(cmd['agc_enable'], function(err,cb) {
          if (err){ callback(err)}
          else { 
            reader.write(cmd['am_input'], function(err,cb) {
            if (err){ callback(err,cb)}
            else { 
              logger.log('info', "ran initcodes!");
              }
            });
          }
        });
      }
    });
  }
  
  // Hex string to ASCII
  var hex2a = function(hex) {
    var str = '';
    for (var i = 0; i < hex.length; i += 2)
        str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return str;
  }
  
  var dec2hex = function(d) {
    return ("0"+(Number(d).toString(16))).slice(-2).toUpperCase()
  }
  
  // TAG LOOP FUNCTIONS - do inventory check
  //var scanLoop = setInterval(function() { scanTagLoop(readerConfig.protocols[self.tagtype]) }, 1000 );
    
  this.scanTagLoop = function (){ 
    // run inventory check in intervals
    inventory(readerConfig.protocols[self.tagtype]['inventory'], function(err) {
      if (err) { logger.log('error', err) }
    });
  }
  
  var stopScan = function() {
    clearInterval(scanLoop);
  }
  
  // inventory command
  var inventory = function(cmd, callback) {
    reader.write(cmd, function(err) {
      if (err) { 
        logger.log('error', err);
        callback(err)
      }
      else { 
        logger.log('info', 'ran inventory!') 
      }
    });
  }
  // END TAG LOOP FUNCTIONS
  
  // initialize read tag loop
  var readTag = function( tag, callback ) {
    reader.emit('initcodes', readerConfig.protocols[self.tagtype]['initcodes']);
    logger.log('debug', "found tag id: " + tag );
    readData = '';  // reset data
    offset = start_offset;
    logger.log('debug', "sending readtagdata event, offset: "+offset );
    reader.emit('readtagdata', offset);
  }
  
  // read data loop
  var readTagData = function( offset, callback ) {
    if(offset != self.length_to_read) {
      cmd = ['01','0C','00','03','04','18','00','23', dec2hex(offset), dec2hex(self.bytes_per_read), '00', '00'].join('');
      logger.log('debug', "offset: "+offset+ " tagdata cmd: " + cmd );
      reader.write(cmd, function(err) {
        if(err) { throw new Error (err) }
        offset += self.bytes_per_read +1; // need to shift offset by 1
        // do we need to delay read to next event loop?
        process.nextTick(function() {
          readTagData(offset);
        });
      });
    }
  }
  
  // function rfidData, on rfiddata event
  var rfidData = function( data, callback) {
    var str = hex2a(data);
    logger.log('debug', "rfiddata received: " + str );
    readData += str;
    // rfid data consumed
    if (readData.length >= self.length_to_read || /575F4F4B/.test(str)) {
      reader.removeListener('readtag', readTag);    
      reader.emit('rfidresult', readData);
      // reader.emit('scanloop', readerConfig.protocols[self.tagType]);
      // start new scanloop
      scanLoop = setInterval(function() { self.scanTagLoop(readerConfig.protocols[self.tagtype]) }, self.scaninterval );
    } else {
      // continue reading
      offset += self.bytes_per_read + 1; // need to shift offset with 1
      reader.emit('readtagdata', offset);
    }
  }
  
  // data event
  var gotData = function( data ) {
    logger.log('debug', 'received: '+data);
    data = String(data)
    if(!!data) {
      // ISO15693 needs special treatment
      if(self.tagtype == 'ISO15693') {
        // ISO15693 NO TAG
        if (/,40]/.test(data)) {
          logger.log('debug', 'no tag ...');
          if (tagData) {                              // if tagData exist then tag is considered removed
            reader.emit('tagremoved')
          }
        } 
        // ISO15693 TAG
        else if (/,..]/.test(data)) {                 // we have an inventory response! (comma and position)
          var tag=data.match(/\[([0-9A-F]+)\,..\]/);  // check for actual tag - strip away empty tag location ids (eg. ',40) 
          if (tag && tag[1]) {   
            reader.emit('tagfound', tag[1]);
          }
        }
        
        // ISO15693 RFID DATA
        else if (/\[.+\]/.test(data)) {                // we have response data! (within brackets, no comma)
          var rfiddata = data.match(/\[00(.+)\]/);     // strip initial 00 response
          logger.log('debug', "response data! "+rfiddata);
          if (rfiddata) {
            reader.emit('rfiddata', rfiddata[1]);
          }
        } 
      // ANY OTHER PROXIMITY TAG
      } 
      else if (/\[.+\]/.test(data)) {
        var tag = data.match(/\[(.+)\]/);            // tag is anything between brackets
        logger.log('debug', "tag! "+tag);
        if (tag && tag[1]) {
          reader.emit('tagfound', tag[1]);
        }
      } 
    }
  }
}

Rfidgeek.prototype.start = function() {
  var self = this;
  scanLoop = setInterval(function() { self.scanTagLoop() }, self.scaninterval );
}

Rfidgeek.prototype.stop = function() {
  clearInterval(scanLoop);
}

module.exports = Rfidgeek  
  // for browser compatibility
  //if (typeof module !== 'undefined' && typeof module.exports !== 'undefined')
  //  module.exports = rfidGeek;
  //else
  //  window.rfidGeek = rfidGeek;
//})();
