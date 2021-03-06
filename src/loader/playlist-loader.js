/**
 * Playlist Loader
*/

import Event from '../events';
import EventHandler from '../event-handler';
import {ErrorTypes, ErrorDetails} from '../errors';
import URLHelper from '../utils/url';
import AttrList from '../utils/attr-list';
import {logger} from '../utils/logger';

class PlaylistLoader extends EventHandler {

  constructor(hls) {
    super(hls,
      Event.MANIFEST_LOADING,
      Event.LEVEL_LOADING,
      Event.AUDIO_TRACK_LOADING);
    this.loaders = {};
  }

  destroy() {
    for (let loaderName in this.loaders) {
      let loader = this.loaders[loaderName];
      if (loader) {
        loader.destroy();
      }
    }
    this.loaders = {};
    EventHandler.prototype.destroy.call(this);
  }

  onManifestLoading(data) {
    this.load(data.url, { type : 'manifest'});
  }

  onLevelLoading(data) {
    this.load(data.url, { type : 'level', level : data.level, id : data.id});
  }

  onAudioTrackLoading(data) {
    this.load(data.url, { type : 'audioTrack', id : data.id});
  }

  load(url, context) {
    var config = this.hls.config,
        retry,
        timeout,
        retryDelay;
    if(context.type === 'manifest') {
      retry = config.manifestLoadingMaxRetry;
      timeout = config.manifestLoadingTimeOut;
      retryDelay = config.manifestLoadingRetryDelay;
    } else {
      retry = config.levelLoadingMaxRetry;
      timeout = config.levelLoadingTimeOut;
      retryDelay = config.levelLoadingRetryDelay;
    }
    let loader = this.loaders[context.type];
    if (loader) {
      logger.warn(`abort previous loader for type:${context.type}`);
      loader.abort();
    }
    loader  = this.loaders[context.type] = context.loader = typeof(config.pLoader) !== 'undefined' ? new config.pLoader(config) : new config.loader(config);
    loader.load(url, context, '', this.loadsuccess.bind(this), this.loaderror.bind(this), this.loadtimeout.bind(this), timeout, retry, retryDelay);
  }

  resolve(url, baseUrl) {
    return URLHelper.buildAbsoluteURL(baseUrl, url);
  }

  parseMasterPlaylist(string, baseurl) {
    let levels = [], result;

    // https://regex101.com is your friend
    const re = /#EXT-X-STREAM-INF:([^\n\r]*)[\r\n]+([^\r\n]+)/g;
    while ((result = re.exec(string)) != null){
      const level = {};

      var attrs = level.attrs = new AttrList(result[1]);
      level.url = this.resolve(result[2], baseurl);

      var resolution = attrs.decimalResolution('RESOLUTION');
      if(resolution) {
        level.width = resolution.width;
        level.height = resolution.height;
      }
      level.bitrate = attrs.decimalInteger('AVERAGE-BANDWIDTH') || attrs.decimalInteger('BANDWIDTH');
      level.name = attrs.NAME;

      var codecs = attrs.CODECS;
      if(codecs) {
        codecs = codecs.split(',');
        for (let i = 0; i < codecs.length; i++) {
          const codec = codecs[i];
          if (codec.indexOf('avc1') !== -1) {
            level.videoCodec = this.avc1toavcoti(codec);
          } else {
            level.audioCodec = codec;
          }
        }
      }

      levels.push(level);
    }
    return levels;
  }

  parseMasterPlaylistMedia(string, baseurl, type) {
    let medias = [], result, id = 0;

    // https://regex101.com is your friend
    const re = /#EXT-X-MEDIA:(.*)/g;
    while ((result = re.exec(string)) != null){
      const media = {};
      var attrs = new AttrList(result[1]);
      if(attrs.TYPE === type) {
        media.groupId = attrs['GROUP-ID'];
        media.name = attrs.NAME;
        media.default = (attrs.DEFAULT === 'YES');
        media.autoselect = (attrs.AUTOSELECT === 'YES');
        media.forced = (attrs.FORCED === 'YES');
        media.url = (attrs.URI)?this.resolve(attrs.URI, baseurl):'';
        media.lang = attrs.LANGUAGE;
        if(!media.name) {
            media.name = media.lang;
        }
        media.id = id++;
        medias.push(media);
      }
    }
    return medias;
  }
  /**
   * Utility method for parseLevelPlaylist to create an initialization vector for a given segment
   * @returns {Uint8Array}
   */
  createInitializationVector (segmentNumber) {
    var uint8View = new Uint8Array(16);

    for (var i = 12; i < 16; i++) {
      uint8View[i] = (segmentNumber >> 8 * (15 - i)) & 0xff;
    }

    return uint8View;
  }

  /**
   * Utility method for parseLevelPlaylist to get a fragment's decryption data from the currently parsed encryption key data
   * @param levelkey - a playlist's encryption info
   * @param segmentNumber - the fragment's segment number
   * @returns {*} - an object to be applied as a fragment's decryptdata
   */
  fragmentDecryptdataFromLevelkey (levelkey, segmentNumber) {
    var decryptdata = levelkey;

    if (levelkey && levelkey.method && levelkey.uri && !levelkey.iv) {
      decryptdata = this.cloneObj(levelkey);
      decryptdata.iv = this.createInitializationVector(segmentNumber);
    }

    return decryptdata;
  }

  avc1toavcoti(codec) {
    var result, avcdata = codec.split('.');
    if (avcdata.length > 2) {
      result = avcdata.shift() + '.';
      result += parseInt(avcdata.shift()).toString(16);
      result += ('000' + parseInt(avcdata.shift()).toString(16)).substr(-4);
    } else {
      result = codec;
    }
    return result;
  }

  cloneObj(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  parseLevelPlaylist(string, baseurl, id, type) {
    var currentSN = 0,
        fragdecryptdata,
        totalduration = 0,
        level = {type: null, version: null, url: baseurl, fragments: [], live: true, startSN: 0},
        levelkey = {method : null, key : null, iv : null, uri : null},
        cc = 0,
        programDateTime = null,
        frag = null,
        result,
        regexp,
        duration = null,
        title = null,
        byteRangeEndOffset = null,
        byteRangeStartOffset = null,
        tagList = [];

    regexp = /(?:(?:#(EXTM3U))|(?:#EXT-X-(PLAYLIST-TYPE):(.+))|(?:#EXT-X-(MEDIA-SEQUENCE):(\d+))|(?:#EXT-X-(TARGETDURATION):(\d+))|(?:#EXT-X-(KEY):(.+))|(?:#EXT-X-(START):(.+))|(?:#EXT(INF):(\d+(?:\.\d+)?)(?:,(.*))?)|(?:(?!#)()(\S.+))|(?:#EXT-X-(BYTERANGE):(\d+(?:@\d+(?:\.\d+)?))|(?:#EXT-X-(ENDLIST))|(?:#EXT-X-(DIS)CONTINUITY))|(?:#EXT-X-(PROGRAM-DATE-TIME):(.+))|(?:#EXT-X-(VERSION):(\d+))|(?:(#)(.*):(.*))|(?:(#)(.*)))(?:.*)\r?\n?/g;
    while ((result = regexp.exec(string)) !== null) {
      result.shift();
      result = result.filter(function(n) { return (n !== undefined); });
      switch (result[0]) {
        case 'PLAYLIST-TYPE':
          level.type = result[1].toUpperCase();
          break;
        case 'MEDIA-SEQUENCE':
          currentSN = level.startSN = parseInt(result[1]);
          break;
        case 'TARGETDURATION':
          level.targetduration = parseFloat(result[1]);
          break;
        case 'VERSION':
          level.version = parseInt(result[1]);
          break;
        case 'EXTM3U':
          break;
        case 'ENDLIST':
          level.live = false;
          break;
        case 'DIS':
          cc++;
          tagList.push(result);
          break;
        case 'BYTERANGE':
          var params = result[1].split('@');
          if (params.length === 1) {
            byteRangeStartOffset = byteRangeEndOffset;
          } else {
            byteRangeStartOffset = parseInt(params[1]);
          }
          byteRangeEndOffset = parseInt(params[0]) + byteRangeStartOffset;
          break;
        case 'INF':
          duration = parseFloat(result[1]);
          title = result[2] ? result[2] : null;
          tagList.push(result);
          break;
        case '': // url
          if (!isNaN(duration)) {
            var sn = currentSN++;
            fragdecryptdata = this.fragmentDecryptdataFromLevelkey(levelkey, sn);
            var url = result[1] ? this.resolve(result[1], baseurl) : null;
            frag = {url: url,
                    type : type,
                    duration: duration,
                    title: title,
                    start: totalduration,
                    sn: sn,
                    level: id,
                    cc: cc,
                    byteRangeStartOffset: byteRangeStartOffset,
                    byteRangeEndOffset: byteRangeEndOffset,
                    decryptdata : fragdecryptdata,
                    programDateTime: programDateTime,
                    tagList: tagList};
            level.fragments.push(frag);
            totalduration += duration;
            duration = null;
            title = null;
            byteRangeStartOffset = null;
            programDateTime = null;
            tagList = [];
          }
          break;
        case 'KEY':
          // https://tools.ietf.org/html/draft-pantos-http-live-streaming-08#section-3.4.4
          var decryptparams = result[1];
          var keyAttrs = new AttrList(decryptparams);
          var decryptmethod = keyAttrs.enumeratedString('METHOD'),
              decrypturi = keyAttrs.URI,
              decryptiv = keyAttrs.hexadecimalInteger('IV');
          if (decryptmethod) {
            levelkey = { method: null, key: null, iv: null, uri: null };
            if ((decrypturi) && (decryptmethod === 'AES-128')) {
              levelkey.method = decryptmethod;
              // URI to get the key
              levelkey.uri = this.resolve(decrypturi, baseurl);
              levelkey.key = null;
              // Initialization Vector (IV)
              levelkey.iv = decryptiv;
            }
          }
          break;
        case 'START':
          let startParams = result[1];
          let startAttrs = new AttrList(startParams);
          let startTimeOffset = startAttrs.decimalFloatingPoint('TIME-OFFSET');
          if (startTimeOffset) {
            level.startTimeOffset = startTimeOffset;
          }
          break;
        case 'PROGRAM-DATE-TIME':
          programDateTime = new Date(Date.parse(result[1]));
          tagList.push(result);
          break;
        case '#':
          result.shift();
          tagList.push(result);
          break;
        default:
          logger.warn(`line parsed but not handled: ${result}`);
          break;
      }
    }
    //logger.log('found ' + level.fragments.length + ' fragments');
    if(frag && !frag.url) {
      level.fragments.pop();
      totalduration-=frag.duration;
    }
    level.totalduration = totalduration;
    level.averagetargetduration = totalduration / level.fragments.length;
    level.endSN = currentSN - 1;
    return level;
  }

  loadsuccess(event, stats, context) {
    var target = event.currentTarget,
        string = target.responseText,
        url = target.responseURL,
        type = context.type,
        id = context.id,
        level = context.level,
        hls = this.hls;

    this.loaders[type] = undefined;
    // responseURL not supported on some browsers (it is used to detect URL redirection)
    // data-uri mode also not supported (but no need to detect redirection)
    if (url === undefined || url.indexOf('data:') === 0) {
      // fallback to initial URL
      url = context.url;
    }
    stats.tload = performance.now();
    stats.mtime = new Date(target.getResponseHeader('Last-Modified'));
    if (string.indexOf('#EXTM3U') === 0) {
      if (string.indexOf('#EXTINF:') > 0) {
        // 1 level playlist
        // if first request, fire manifest loaded event, level will be reloaded afterwards
        // (this is to have a uniform logic for 1 level/multilevel playlists)
        if (type === 'manifest') {
          hls.trigger(Event.MANIFEST_LOADED, {levels: [{url: url}], url: url, stats: stats});
        } else {
          let isLevel = (type === 'level'),
              levelDetails = this.parseLevelPlaylist(string, url, level || id, isLevel ? 'main' : 'audio');
          stats.tparsed = performance.now();
          if (isLevel) {
            hls.trigger(Event.LEVEL_LOADED, {details: levelDetails, level: level, id: id, stats: stats});
          } else {
            hls.trigger(Event.AUDIO_TRACK_LOADED, {details: levelDetails, id: id, stats: stats});
          }
        }
      } else {
        let levels = this.parseMasterPlaylist(string, url),
            audiotracks = this.parseMasterPlaylistMedia(string, url, 'AUDIO');
        // multi level playlist, parse level info
        if (levels.length) {
          hls.trigger(Event.MANIFEST_LOADED, {levels: levels, audioTracks : audiotracks, url: url, stats: stats});
        } else {
          hls.trigger(Event.ERROR, {type: ErrorTypes.NETWORK_ERROR, details: ErrorDetails.MANIFEST_PARSING_ERROR, fatal: true, url: url, reason: 'no level found in manifest'});
        }
      }
    } else {
      hls.trigger(Event.ERROR, {type: ErrorTypes.NETWORK_ERROR, details: ErrorDetails.MANIFEST_PARSING_ERROR, fatal: true, url: url, reason: 'no EXTM3U delimiter'});
    }
  }

  loaderror(event, context) {
    var details, fatal,loader = context.loader;
    switch(context.type) {
      case 'manifest':
        details = ErrorDetails.MANIFEST_LOAD_ERROR;
        fatal = true;
        break;
      case 'level':
        details = ErrorDetails.LEVEL_LOAD_ERROR;
        fatal = false;
        break;
      case 'audioTrack':
        details = ErrorDetails.AUDIO_TRACK_LOAD_ERROR;
        fatal = false;
        break;
    }
    if (loader) {
      loader.abort();
      this.loaders[context.type] = undefined;
    }
    this.hls.trigger(Event.ERROR, {type: ErrorTypes.NETWORK_ERROR, details: details, fatal: fatal, url: loader.url, loader: loader, response: event.currentTarget, context : context});
  }

  loadtimeout(event, stats, context) {
    var details, fatal, loader = context.loader;
    switch(context.type) {
      case 'manifest':
        details = ErrorDetails.MANIFEST_LOAD_TIMEOUT;
        fatal = true;
        break;
      case 'level':
        details = ErrorDetails.LEVEL_LOAD_TIMEOUT;
        fatal = false;
        break;
      case 'audioTrack':
        details = ErrorDetails.AUDIO_TRACK_LOAD_TIMEOUT;
        fatal = false;
        break;
    }
    if (loader) {
      loader.abort();
      this.loaders[context.type] = undefined;
    }
    this.hls.trigger(Event.ERROR, {type: ErrorTypes.NETWORK_ERROR, details: details, fatal: fatal, url: loader.url, loader: loader, context : context});
  }
}

export default PlaylistLoader;
