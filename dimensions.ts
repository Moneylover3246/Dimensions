///<reference path="./typings/index.d.ts"/>
import * as redis from 'redis';
import RoutingServer from 'routingserver';
import ListenServer from 'listenserver';
import {ConfigSettings, Config, ConfigOptions} from 'configloader';
import Client from 'client';
import {requireNoCache} from 'utils';
import * as _ from 'lodash';
import ClientCommandHandler from 'clientcommandhandler';
import TerrariaServerPacketHandler from 'terrariaserverpackethandler';
import ServerDetails from 'serverdetails';
import GlobalHandlers from 'globalhandlers';
import ReloadTask from 'reloadtask';
import GlobalTracking from 'globaltracking';
import Extensions from 'extensions';
import ClientPacketHandler from 'clientpackethandler';
import RestApi from 'restapi';
import Logger from 'logger';

/* The core that sets up the listen servers, rest api and handles reloading */
class Dimensions {
  servers: { [id: string]: RoutingServer };
  options: ConfigOptions;
  listenServers: { [id: number]: ListenServer };
  handlers: GlobalHandlers;
  redisClient: redis.RedisClient;
  serversDetails: { [id: string]: ServerDetails };
  globalTracking: GlobalTracking;
  restApi: RestApi;
  logging: Logger;

  constructor(logging: Logger) {
    this.options = ConfigSettings.options;
    this.logging = logging;
    this.handlers = {
      command: new ClientCommandHandler(),
      clientPacketHandler: new ClientPacketHandler(),
      terrariaServerPacketHandler: new TerrariaServerPacketHandler(),
      extensions: []
    };
    
    Extensions.loadExtensions(this.handlers.extensions, this.options.log.extensionLoad);

    this.redisClient = redis.createClient();
    this.redisClient.subscribe('dimensions_cli');
    this.redisClient
      .on('message', (channel: string, message: string) => {
        if (channel === "dimensions_cli") {
          this.handleCommand(message);
        }
      })
      .on('error', (err: Error) => {
        console.log("RedisError: " + err);
      });

    this.serversDetails = {};
    this.listenServers = {};
    this.servers = {};
    this.globalTracking = {
      names: {}
    };

    for (let i: number = 0; i < ConfigSettings.servers.length; i++) {
      let listenKey = ConfigSettings.servers[i].listenPort;
      this.listenServers[listenKey] = new ListenServer(ConfigSettings.servers[i], this.serversDetails, this.handlers, this.servers, this.options, this.globalTracking, this.logging);

      for (let j: number = 0; j < ConfigSettings.servers[i].routingServers.length; j++) {
        this.servers[ConfigSettings.servers[i].routingServers[j].name] = ConfigSettings.servers[i].routingServers[j];
      }
    }

    if (this.options.restApi.enabled) {
      this.restApi = new RestApi(this.options.restApi.port, this.globalTracking, this.serversDetails, this.servers);
    }
  }

  /* Prints out the names currently used and the number of people on each Dimension */
  printServerCounts(): void {
    let serverKeys: string[] = _.keys(this.servers);
    let info = "";
    for (let i: number = 0; i < serverKeys.length; i++) {
      info += "[" + serverKeys[i] + ": " + this.serversDetails[serverKeys[i]].clientCount + "] ";
    }

    console.log(this.globalTracking.names);
    console.log(info);
  }

  /* Handles commands received by the subscribed Redis channel */
  handleCommand(cmd: string): void {
    switch (cmd) {
      case "players":
        this.printServerCounts();
        break;
      case "reload":
        this.reloadServers();
        break;
      case "reloadhandlers":
        this.reloadClientHandlers();
        this.reloadTerrariaServerHandlers();
        console.log("\u001b[33mReloaded Packet Handlers.\u001b[0m");
        break;
      case "reloadcmds":
          try {
            let ClientCommandHandler = requireNoCache('./clientcommandhandler.js', require).default;
            this.handlers.command = new ClientCommandHandler();
          } catch (e) {
            console.log("Error loading Command Handler: " + e);
          }
        
        console.log("\u001b[33mReloaded Command Handler.\u001b[0m");
        break;
      case "reloadextensions":
      case "reloadplugins":
        this.reloadExtensions();
        break;
      default:
        this.passOnReloadToExtensions();
        break;
    }
  }

  /* When a command is not directly handled by handleCommand, it comes through here and is
   * passed on to each extension in-case they have it as a command */
  passOnReloadToExtensions(): void {
    let handlers = this.handlers.extensions;
    for (let key in handlers) {
      let handler = handlers[key];
      if (handler.reloadable && typeof handler.reloadName !== 'undefined') {
        if (typeof handler.reload === 'function') {
          handler.reload(require);
        }
      }
    }
  }

  /* Loads a new instance of ClientPacketHandler by requiring the file again */
  reloadClientHandlers(): void {
      try {
        let ClientPacketHandler = requireNoCache('./clientpackethandler.js', require).default;
        this.handlers.clientPacketHandler = new ClientPacketHandler();
      } catch (e) {
        console.log("Error loading Client Packet Handler: " + e);
      }
  }

  /* Loads a new instance of TerrariaServerPacketHandler by requiring the file again */
  reloadTerrariaServerHandlers(): void {
      try {
        let TerrariaServerPacketHandler = requireNoCache('./terrariaserverpackethandler.js', require).default;
        this.handlers.terrariaServerPacketHandler = new TerrariaServerPacketHandler();
      } catch (e) {
        console.log("Error loading TerrariaServer Packet Handler: " + e);
      }
  }

  /* Unloads and re-loads all extensions directly from their directories */
  reloadExtensions(): void {
    if (this.options.log.extensionLoad) {
      for (let key in this.handlers.extensions) {
        let extension = this.handlers.extensions[key];
        console.log(`\u001b[33m[Extension] ${extension.name} ${extension.version} unloaded.\u001b[0m`);
      } 
    }

    this.handlers.extensions = [];
    Extensions.loadExtensions(this.handlers.extensions, this.options.log.extensionLoad);
  }

  /* Checks the config servers against the existing listen servers and updates any allocations
   * of each individual dimension to the appropriate listenserver, and will destroy any listenservers
   * that no longer should exist, and starts up new ones on the specified ports from the config */
  reloadServers(): void {
      try {
        let ConfigSettings = requireNoCache('../config.js', require).ConfigSettings;
        if (ConfigSettings.options.restApi.enabled) {
          this.restApi.handleReload(ConfigSettings.options.restApi.port);
        }

        let currentRoster = {};
        let runAfterFinished: Array<ReloadTask> = [];
        for (let i: number = 0; i < ConfigSettings.servers.length; i++) {
          let listenKey: number = ConfigSettings.servers[i].listenPort;
          if (this.listenServers[listenKey]) {
            this.listenServers[listenKey].updateInfo(ConfigSettings.servers[i]);
            for (var j = 0; j < ConfigSettings.servers[i].routingServers.length; j++) {
              this.servers[ConfigSettings.servers[i].routingServers[j].name] = ConfigSettings.servers[i].routingServers[j];
            }
          } else {
            runAfterFinished.push({
              key: listenKey,
              index: i
            });
          }

          currentRoster[listenKey] = 1;
        }

        let currentListenServers: string[] = _.keys(this.listenServers);
        for (let i: number = 0; i < currentListenServers.length; i++) {
          if (!currentRoster[currentListenServers[i]]) {
            // Close down
            this.listenServers[currentListenServers[i]].shutdown();
            delete this.listenServers[currentListenServers[i]];
          }
        }

        for (let i: number = 0; i < runAfterFinished.length; i++) {
          var serversIndex = runAfterFinished[i].index;
          this.listenServers[runAfterFinished[i].key] = new ListenServer(ConfigSettings.servers[serversIndex], this.serversDetails, this.handlers, this.servers, this.options, this.globalTracking, this.logging);
          for (let j: number = 0; j < ConfigSettings.servers[serversIndex].routingServers.length; j++) {
            this.servers[ConfigSettings.servers[serversIndex].routingServers[j].name] = ConfigSettings.servers[serversIndex].routingServers[j];
          }
        }

        // Update options
        let keys: string[] = _.keys(this.options);
        for (let i = 0; i < keys.length; i++) {
          this.options[keys[i]] = ConfigSettings.options[keys[i]];
        }
      } catch (e) {
        console.log("Error loading Config: " + e);
      }
      console.log("\u001b[33mReloaded Config.\u001b[0m");
  }
}

export default Dimensions;