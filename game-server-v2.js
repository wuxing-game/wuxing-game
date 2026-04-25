var http = require('http');
var fs = require('fs');
var path = require('path');
var https = require('https');
var WebSocket = require('ws');

var PORT = 3002;
var rooms = {};
var clients = {};
var nextCid = 1;
var ADMIN_KEY = 'tianyun2025admin';

// GitHub config for auto-update
var GH_OWNER = 'wuxing-game';
var GH_REPO = 'wuxing-game';
var GH_BRANCH = 'main';

var server = http.createServer(function(req, res) {
  var url = req.url.split('?')[0];
  
  // Admin update route - pull files from GitHub
  if (url === '/admin/update') {
    var queryKey = require('url').parse(req.url, true).query.key;
    if (queryKey !== ADMIN_KEY) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }
    updateFromGitHub(res);
    return;
  }
  
  // Admin restart route
  if (url === '/admin/restart') {
    var queryKey = require('url').parse(req.url, true).query.key;
    if (queryKey !== ADMIN_KEY) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Restarting in 2 seconds...');
    setTimeout(function() { process.exit(0); }, 2000);
    return;
  }

  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'tianyun-game.html'), function(err, data) {
      if (err) {
        res.writeHead(500);
        res.end('Error loading tianyun-game.html');
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate'});
      res.end(data);
    });
  } else if (url === '/board.png') {
    fs.readFile(path.join(__dirname, 'board.png'), function(err, data) {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'no-cache'});
      res.end(data);
    });
  } else if (url === '/tianyun-simple.html') {
    fs.readFile(path.join(__dirname, 'tianyun-simple.html'), function(err, data) {
      if (err) {
        res.writeHead(500);
        res.end('Error loading tianyun-simple.html');
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate'});
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

function updateFromGitHub(res) {
  var files = ['tianyun-game.html', 'tianyun-simple.html', 'game-server.js', 'board.png'];
  var results = [];
  var done = 0;
  
  res.writeHead(200, {'Content-Type': 'text/plain'});
  
  files.forEach(function(filename) {
    var options = {
      hostname: 'api.github.com',
      path: '/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' + filename + '?ref=' + GH_BRANCH,
      method: 'GET',
      headers: {
        'User-Agent': 'TianyunGameServer',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    
    var ghReq = https.request(options, function(ghRes) {
      var body = '';
      ghRes.on('data', function(chunk) { body += chunk; });
      ghRes.on('end', function() {
        try {
          var parsed = JSON.parse(body);
          if (parsed.content) {
            var fileData = Buffer.from(parsed.content.replace(/\n/g, ''), 'base64');
            var filePath = path.join(__dirname, filename);
            fs.writeFileSync(filePath, fileData);
            results.push(filename + ': OK (' + (fileData.length/1024).toFixed(1) + 'KB)');
          } else {
            results.push(filename + ': FAILED (no content)');
          }
        } catch(e) {
          results.push(filename + ': ERROR (' + e.message + ')');
        }
        done++;
        if (done === files.length) {
          var msg = 'Update results:\n' + results.join('\n') + '\n\nRestart needed for game-server.js changes.';
          res.end(msg);
          console.log('[UPDATE] ' + msg);
        }
      });
    });
    
    ghReq.on('error', function(e) {
      results.push(filename + ': NETWORK ERROR (' + e.message + ')');
      done++;
      if (done === files.length) {
        res.end('Update results:\n' + results.join('\n'));
      }
    });
    
    ghReq.end();
  });
}

var wss = new WebSocket.Server({server: server});

wss.on('connection', function(ws) {
  var cid = nextCid++;
  console.log('[SERVER] Client connected: ' + cid);
  clients[cid] = { socket: ws, room: null, role: null };
  
  ws.on('message', function(data) {
    try {
      var msg = JSON.parse(data.toString());
      console.log('[SERVER] Received:', msg.type, 'from cid:', cid);
      handleGameMessage(cid, msg, ws);
    } catch (e) {
      console.log('[SERVER] JSON parse error:', e.message);
    }
  });
  
  ws.on('close', function() {
    console.log('[SERVER] Client disconnected: ' + cid);
    if (clients[cid] && clients[cid].room) {
      var r = rooms[clients[cid].room];
      if (r) {
        var otherCid = (r.hostCid === cid) ? r.guestCid : r.hostCid;
        if (otherCid && clients[otherCid]) {
          try {
            clients[otherCid].socket.send(JSON.stringify({type: 'opponent_left'}));
          } catch(e) {}
        }
        delete rooms[clients[cid].room];
      }
    }
    delete clients[cid];
  });
  
  ws.on('error', function(err) {
    console.log('[SERVER] WebSocket error:', err.message);
  });
});

function handleGameMessage(cid, msg, ws) {
  var type = msg.type;
  var roomCode = msg.roomCode || msg.rc;
  
  if (type === 'create_room' || type === 'cr') {
    var rc = String(roomCode || '');
    if (rc.length !== 4 || isNaN(rc)) {
      ws.send(JSON.stringify({type: 'error', message: '房间号必须是4位数字'}));
      return;
    }
    if (rooms[rc]) {
      ws.send(JSON.stringify({type: 'error', message: '房间号已存在'}));
      return;
    }
    rooms[rc] = { hostCid: cid, guestCid: null, ts: Date.now() };
    clients[cid].room = rc;
    clients[cid].role = 'host';
    ws.send(JSON.stringify({type: 'room_created', roomCode: rc}));
  }
  else if (type === 'join_room' || type === 'jr') {
    var code = String(roomCode || '');
    if (!rooms[code]) {
      ws.send(JSON.stringify({type: 'error', message: '房间不存在或已关闭'}));
      return;
    }
    if (rooms[code].guestCid) {
      ws.send(JSON.stringify({type: 'error', message: '房间已满'}));
      return;
    }
    rooms[code].guestCid = cid;
    rooms[code].ts = Date.now();
    clients[cid].room = code;
    clients[cid].role = 'guest';
    ws.send(JSON.stringify({type: 'room_joined'}));
    var hostC = clients[rooms[code].hostCid];
    if (hostC && hostC.socket.readyState === WebSocket.OPEN) {
      hostC.socket.send(JSON.stringify({type: 'guest_joined'}));
    }
  }
  else if (type === 'game_data' || type === 'gd') {
    var inner = msg.data;
    if (!inner || !inner.type) return;
    if (!clients[cid].room || !rooms[clients[cid].room]) return;
    var r = rooms[clients[cid].room];
    var otherCid = (r.hostCid === cid) ? r.guestCid : r.hostCid;
    if (otherCid && clients[otherCid] && clients[otherCid].socket.readyState === WebSocket.OPEN) {
      clients[otherCid].socket.send(JSON.stringify({type:'game_data', data:inner}));
    }
  }
  else if (type === 'cancel_room' || type === 'cancelR') {
    if (!clients[cid].room) return;
    var r = rooms[clients[cid].room];
    if (r) {
      var otherCid = (r.hostCid === cid) ? r.guestCid : r.hostCid;
      if (otherCid && clients[otherCid]) {
        clients[otherCid].socket.send(JSON.stringify({type: 'opponent_left'}));
      }
    }
    delete rooms[clients[cid].room];
    clients[cid].room = null;
    clients[cid].role = null;
  }
  else if (type === 'leave_room' || type === 'leaveR') {
    if (!clients[cid].room) return;
    var r = rooms[clients[cid].room];
    if (r) {
      var otherCid = (r.hostCid === cid) ? r.guestCid : r.hostCid;
      if (otherCid && clients[otherCid]) {
        clients[otherCid].socket.send(JSON.stringify({type: 'opponent_left'}));
      }
      if (r.hostCid === cid) { r.hostCid = r.guestCid; r.guestCid = null; }
      else if (r.guestCid === cid) { r.guestCid = null; }
      if (!r.hostCid && !r.guestCid) delete rooms[clients[cid].room];
    }
    clients[cid].room = null;
    clients[cid].role = null;
  }
  else if (type === 'ping') {
    ws.send(JSON.stringify({type: 'pong'}));
  }
}

process.on('uncaughtException', function(err) {
  console.log('[SERVER] Uncaught exception:', err.message);
});

server.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
