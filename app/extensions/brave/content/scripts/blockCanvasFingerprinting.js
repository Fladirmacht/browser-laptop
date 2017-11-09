/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Some parts of this file are derived from:
 * Chameleon <https://github.com/ghostwords/chameleon>, Copyright (C) 2015 ghostwords
 * Privacy Badger Chrome <https://github.com/EFForg/privacybadger>, Copyright (C) 2015 Electronic Frontier Foundation and other contributors
 */

if (chrome.contentSettings.canvasFingerprinting == 'block') {
  Error.stackTraceLimit = Infinity // collect all frames

  // https://code.google.com/p/v8-wiki/wiki/JavaScriptStackTraceApi
  /**
   * Customize the stack trace
   * @param structured If true, change to customized version
   * @returns {*} Returns the stack trace
   */
  function getStackTrace (structured) {
    var errObj = {}
    var origFormatter
    var stack

    if (structured) {
      origFormatter = Error.prepareStackTrace
      Error.prepareStackTrace = function (errObj, structuredStackTrace) {
        return structuredStackTrace
      }
    }

    Error.captureStackTrace(errObj, getStackTrace)
    stack = errObj.stack

    if (structured) {
      Error.prepareStackTrace = origFormatter
    }

    return stack
  }

  /**
   * Checks the stack trace for the originating URL
   * @returns {String} The URL of the originating script (URL:Line number:Column number)
   */
  function getOriginatingScriptUrl () {
    var trace = getStackTrace(true)

    if (trace.length < 3) {
      return ''
    }

    // this script is at 0 and 1
    var callSite = trace[2]

    if (callSite.isEval()) {
      // argh, getEvalOrigin returns a string ...
      var eval_origin = callSite.getEvalOrigin()
      var script_url_matches = eval_origin.match(/\((http.*:\d+:\d+)/)

      return script_url_matches && script_url_matches[1] || eval_origin
    } else {
      return callSite.getFileName() + ':' + callSite.getLineNumber() + ':' + callSite.getColumnNumber()
    }
  }

  /**
   *  Strip away the line and column number (from stack trace urls)
   * @param script_url The stack trace url to strip
   * @returns {String} the pure URL
   */
  function stripLineAndColumnNumbers (script_url) {
    return script_url.replace(/:\d+:\d+$/, '')
  }

  // To avoid throwing hard errors on code that expects a fingerprinting feature
  // to be in place, create a method that can be called as if it were most
  // other types of objects (ie can be called like a function, can be indexed
  // into like an array, can have properties looked up, etc).
  //
  // This is done in two steps.  First, create a default, no-op function
  // (`defaultFunc` below), and then second, wrap it in a Proxy that traps
  // on all these operations, and yields itself.  This allows for long
  // chains of no-op operations like
  //    AnalyserNode.prototype.getFloatFrequencyData().bort.alsoBort,
  // even though AnalyserNode.prototype.getFloatFrequencyData has been replaced.
  var defaultFunc = function () {}

  // In order to avoid deeply borking things, we need to make sure we don't
  // prevent access to builtin object properties and functions (things
  // like (Object.prototype.constructor).  So, build a list of those below,
  // and then special case those in the allPurposeProxy object's traps.
  var funcPropNames = Object.getOwnPropertyNames(defaultFunc)
  var unconfigurablePropNames = funcPropNames.filter(function (propName) {
    var possiblePropDesc = Object.getOwnPropertyDescriptor(defaultFunc, propName)
    return (possiblePropDesc && !possiblePropDesc.configurable)
  })

  var valueOfCoercionFunc = function (hint) {
    if (hint === 'string') {
      return ''
    }
    if (hint === 'number' || hint === 'default') {
      return 0
    }
    return undefined
  }

  var callCounter = 0

  var allPurposeProxy = new Proxy(defaultFunc, {
    get: function (target, property) {

      // If the proxy has been called a large number of times on this page,
      // it might be stuck in an loop.  To prevent locking up the page,
      // return undefined to break the loop, and then resume the normal
      // behavior on subsequent calls.
      if (callCounter > 1000) {
        callCounter = 0
        return undefined
      }
      callCounter += 1

      if (property === Symbol.toPrimitive) {
        return valueOfCoercionFunc
      }

      if (property === 'toString') {
        return ''
      }

      if (property === 'valueOf') {
        return 0
      }

      return allPurposeProxy
    },
    set: function () {
      return allPurposeProxy
    },
    apply: function () {
      return allPurposeProxy
    },
    ownKeys: function () {
      return unconfigurablePropNames
    },
    has: function (target, property) {
      return (unconfigurablePropNames.indexOf(property) > -1)
    },
    getOwnPropertyDescriptor: function (target, property) {
      if (unconfigurablePropNames.indexOf(property) === -1) {
        return undefined
      }
      return Object.getOwnPropertyDescriptor(defaultFunc, property)
    }
  })

  function reportBlock (type) {
    var script_url = getOriginatingScriptUrl()
    if (script_url) {
      script_url = stripLineAndColumnNumbers(script_url)
    } else {
      script_url = window.location.href
    }
    var msg = {
      type,
      scriptUrl: stripLineAndColumnNumbers(script_url)
    }

    // Block the read from occuring; send info to background page instead
    chrome.ipcRenderer.sendToHost('got-canvas-fingerprinting', msg)

    return allPurposeProxy
  }

  /**
   * Monitor the reads from a canvas instance
   * @param item special item objects
   */
  function trapInstanceMethod (item) {
    if (!item.methodName) {
      chrome.webFrame.setGlobal(item.objName + ".prototype." + item.propName, reportBlock.bind(null, item.type))
    } else {
      chrome.webFrame.setGlobal(item.methodName, reportBlock.bind(null, item.type))
    }
  }

  var methods = []
  var canvasMethods = ['getImageData', 'getLineDash', 'measureText', 'isPointInPath']
  canvasMethods.forEach(function (method) {
    var item = {
      type: 'Canvas',
      objName: 'CanvasRenderingContext2D',
      propName: method
    }

    methods.push(item)
  })

  var canvasElementMethods = ['toDataURL', 'toBlob']
  canvasElementMethods.forEach(function (method) {
    var item = {
      type: 'Canvas',
      objName: 'HTMLCanvasElement',
      propName: method
    }
    methods.push(item)
  })

  var webglMethods = ['getSupportedExtensions', 'getParameter', 'getContextAttributes',
    'getShaderPrecisionFormat', 'getExtension', 'readPixels', 'getUniformLocation',
    'getAttribLocation']
  webglMethods.forEach(function (method) {
    var item = {
      type: 'WebGL',
      objName: 'WebGLRenderingContext',
      propName: method
    }
    methods.push(item)
    methods.push(Object.assign({}, item, {objName: 'WebGL2RenderingContext'}))
  })

  var audioBufferMethods = ['copyFromChannel', 'getChannelData']
  audioBufferMethods.forEach(function (method) {
    var item = {
      type: 'AudioContext',
      objName: 'AudioBuffer',
      propName: method
    }
    methods.push(item)
  })

  var analyserMethods = ['getFloatFrequencyData', 'getByteFrequencyData',
    'getFloatTimeDomainData', 'getByteTimeDomainData']
  analyserMethods.forEach(function (method) {
    var item = {
      type: 'AudioContext',
      objName: 'AnalyserNode',
      propName: method
    }
    methods.push(item)
  })

  var svgPathMethods = ['getTotalLength']
  svgPathMethods.forEach(function (method) {
    var item = {
      type: 'SVG',
      objName: 'SVGPathElement',
      propName: method
    }
    methods.push(item)
  })

  var svgTextContentMethods = ['getComputedTextLength']
  svgTextContentMethods.forEach(function (method) {
    var item = {
      type: 'SVG',
      objName: 'SVGTextContentElement',
      propName: method
    }
    methods.push(item)
  })

  // Based on https://github.com/webrtcHacks/webrtcnotify
  var webrtcMethods = ['createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription']
  webrtcMethods.forEach(function (method) {
    var item = {
      type: 'WebRTC',
      objName: 'webkitRTCPeerConnection',
      propName: method
    }
    methods.push(item)
  })

  methods.forEach(trapInstanceMethod)

  // Block WebRTC device enumeration
  trapInstanceMethod({
    type: 'WebRTC',
    methodName: 'navigator.mediaDevices.enumerateDevices'
  })

  chrome.webFrame.setGlobal("window.__braveBlockingProxy", allPurposeProxy)
  chrome.webFrame.setGlobal("window.__braveReportBlock", reportBlock.bind(this, 'Iframe'))

  // Prevent access to frames' contentDocument / contentWindow
  // properties, to prevent the parent frame from pulling unblocked
  // references to blocked standards from injected frames.
  // This may break some sites, but, fingers crossed, its not too much.
  var pageScriptToInject = function () {
    var frameTypesToModify = [window.HTMLIFrameElement, window.HTMLFrameElement]
    var propertiesToBlock = ['HTMLCanvasElement',
      'WebGLRenderingContext',
      'WebGL2RenderingContext',
      'CanvasRenderingContext2D',
      'AudioBuffer',
      'AnalyserNode',
      'SVGPathElement',
      'SVGTextContentElement',
      'webkitRTCPeerConnection',
      'navigator']

    var proxyObject = window.__braveBlockingProxy
    delete window.__braveBlockingProxy

    var handler = {
      get: function (target, name) {
        if (propertiesToBlock.includes(name)) {
          // Trigger canvas fingerprinting block
          window.__braveReportBlock()
          return proxyObject
        }
        return target[name]
      }
    }

    frameTypesToModify.forEach(function (frameType) {
      Object.defineProperty(frameType.prototype, 'contentWindow', {
        get: () => {
          // XXX: this breaks contentWindow.postMessage since the target window
          // is now the parent window
          return new Proxy(window, handler)
        }
      })
      Object.defineProperty(frameType.prototype, 'contentDocument', {
        get: () => {
          return new Proxy(document, handler)
        }
      })
    })
  }

  chrome.webFrame.executeJavaScript(`(${pageScriptToInject.toString()})()`)
}
