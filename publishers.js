_initOrReconnect: async function() {
  if (!this.isInitialised) return false

  this.debounce('_initOrReconnect', () => {
    if (this.session && this.session.isConnected()) {
      this._reconnect()
    } else {
      this._init()
    }
  }, 1000)
},

_init: async function() {
  try {
    this.set('creds', await this._fetchCredentials(this.loggedInUser))
    this.set('session', OT.initSession(
      this.creds.api_key,
      this.creds.session_id
    ))

    this.session.on('sessionReconnecting', e => {
      this._handleError(
        new Error(
          'Internet connection lost. Attempting to reconnect...'
        )
      )
    })

    this.session.on('sessionReconnected', e => {
      this._handleError(null)
    })

    this.session.on('sessionDisconnected', e => {
      this.set('connections', [])
      this._handleError(null)
    })

    this.session.on('connectionCreated', e => {
      this._handleConnectionCreated(e.connection)
    })

    this.session.on('connectionDestroyed', e => {
      this._handleConnectionDestroyed(e.connection)
    })

    this.session.on('streamCreated', e => {
      this._handleStreamCreated(e.stream)
    })

    this.session.on('streamDestroyed', e => {
      this._handleStreamDestroyed(e.stream)
    })

    this.session.on('streamPropertyChanged', e => {
      this._handleStreamPropertyChanged(e)
    })

    this.session.on('signal', e => {
      if (e.data && e.data.action === 'end-call') {
        if (this._nobodyInCall()) return

        this.stopCall()
      }
    })

    await this._connectToSession(this.session, this.creds.token)

    this.set('isSessionConnected', true)

    this._handleSuccess()
  } catch(err) {
    this._handleError(err)
  }
},

_reconnect: async function() {
  console.log('_reconnect')

  try {
    this.set('isSessionConnected', false)
    this.set('creds', await this._fetchCredentials(this.loggedInUser))
    await this.session.disconnect()
    await this._connectToSession(this.session, this.creds.token)

    this.fire('reconnected')

  } catch (err) {
    throw err
  } finally {
    this.set('isSessionConnected', true)
  }
},

_ensureSessionConnected: async function() {
  if (this.session.isConnected())
    return true

  for (let i = 0; i < 10; i++) {
    const isConnected = await new Promise(res => {
      setTimeout(() => res(this.session.isConnected()), 1000)
    })

    if (isConnected) return true
  }

  throw new Error('Session failed to connect. Refreshing the page usually fixes this.')
},

_handleConnectionCreated: function(connection) {
  this.push('connections', new CallConnection({
    connection,
    isMe: connection.id === this.session.connection.id,
    toggleVideo: this.toggleVideo.bind(this),
    toggleScreenShare: this.toggleScreenShare.bind(this)
  }))
},

_handleConnectionDestroyed: function(connection) {
  const i = this._findConnectionIndexById(connection.id)

  this.splice('connections', i, 1)
},

_handleStreamCreated: function(stream, srcObject = undefined) {
  const i = this._findConnectionIndexById(stream.connection.id)

  const connection = this.connections[i]

  this._ensureIPublishOnlyOneVideoStream(stream)

  this.set(
    `connections.${i}.streams.${stream.videoType}`,
    Object.assign(stream, {
      srcObject: srcObject
    })
  )

  this.set(`connections.${i}.isConnected`,
    connection.isMe
    ? true
    : connection.isConnected
  )

  if (this._isInCall()) {
    this._subscribeToUnsubscribedStreams()
  }

  if (this._notInCallButOtherConnectionsInCall()) {
    this.fire('connection-with-stream-added-but-i-am-not-in-call')
  }

  this.fire('connection-started-publishing', connection)
},

_handleStreamDestroyed: function(stream) {
  const i = this._findConnectionIndexById(stream.connection.id)
  const connection = this.connections[i]

  this.set(`connections.${i}.streams.${stream.videoType}`, null)

  const hasAtLeastOneStream = Object.values(connection.streams)
    .some(stream => stream)

  if (!hasAtLeastOneStream) {
    this.set(`connections.${i}.isConnected`, false)
  }
},

_handleStreamPropertyChanged: function({ stream, changedProperty, newValue }) {
  const i = this._findConnectionIndexById(stream.connection.id)

  this.set(
    `connections.${i}.streams.${stream.videoType}.${changedProperty}`,
    newValue
  )
},

startCall: async function(opts) {
  opts = opts || {}

  this.set('isStartingCall', true)

  try {
    if (!opts.skipAvailableMinutesCheck) {
      const hasAvailableCallMinutes = await this._hasAvailableCallMinutes()

      if (!hasAvailableCallMinutes) {
        this.fire('no-available-call-minutes')

        return this._handleError(new Error('No available call minutes'))
      }
    }

    await this._ensureSessionConnected()
    await this._createPublisher('camera')
    await this._subscribeToUnsubscribedStreams()
    this.set('isStartingCall', false)
    this._handleSuccess()
  } catch(err) {
    this._handleError(err)
  } finally {
    this.set('isStartingCall', false)
  }
},

stopCall: function() {
  this.connections.forEach((connection, i) => {
    Object.values(connection.streams)
      .filter(stream => stream)
      .forEach(stream => {
        if (stream.publisher) {
          this.session.unpublish(stream.publisher)
        } else if (stream.subscriber) {
          this.session.unsubscribe(stream.subscriber)
        } else {
          // do nothing
        }
      })

    this.set(`connections.${i}.isConnected`, false)
  })
},

toggleScreenShare: async function(flag) {
  if (!this.screenSharingCapability.supported) {
    return asyncAlert.open({
      warningText: 'Screen Sharing is not supported on this device.'
    })
  }

  try {
    if (this._isScreenSharing()) {
      await this._stopScreenSharing()
    } else {
      await this._startScreenSharing()
    }

    this._handleSuccess()
  } catch (err) {
    this._handleError(err)
  }
},

toggleVideo: function(flag) {
  const me = this._findMyConnection()

  if (!me) return false

  me.streams.camera.publisher.publishVideo(flag)

  if (me.streams.screen) {
    this._stopScreenSharing()
  }
},

_startScreenSharing: async function() {
  const screenSharingCapability = await new Promise(resolve => {
    OT.checkScreenSharingCapability(res => {
      resolve(res)
    })
  })

  if (!screenSharingCapability.supported) {
    throw new Error('Screen-sharing not supported on this browser')
  } else if (screenSharingCapability.extensionRequired &&
      !screenSharingCapability.extensionInstalled) {
    console.info('Requesting screen share extension installation...')
    this.set('screenshareBlockedDueToExtensionNotInstalled', true)
    return this.fire('request-screen-share-extension-installation')
  }

  this.set('screenshareBlockedDueToExtensionNotInstalled', false)

  return this._createPublisher('screen')
},

_stopScreenSharing: function() {
  const me = this._findMyConnection()

  return me ? this.session.unpublish(me.streams.screen.publisher) : false
},

_subscribeToUnsubscribedStreams: function() {
  const tasks = this.connections
    .reduce((tasks, connection) => {
      const task = Object.values(connection.streams)
        .filter(stream => stream)
        .filter(stream => !stream.publisher)
        .filter(stream => !this.session.getSubscribersForStream(stream).length)
        .map(stream => this._subscribeToStream(stream))

      return tasks.concat(task)
    }, [])

  return Promise.all(tasks)
},

_subscribeToStream: function(stream) {
  return new Promise((resolve, reject) => {
    const subscriber = this.session.subscribe(stream, null, {
      insertDefaultUI: false
    }, err => {
      if (err) {
        this._handleError(err)
        reject(err)

        return
      }
    })

    subscriber.on('videoDisabled', e => {
      if (e.reason === 'quality') {
        const i = this._findConnectionIndexById(e.target.stream.connection.id)
        this.set(`connections.${i}.videoDisabledDueToQuality`, true)
      }
    })

    subscriber.on('videoEnabled', e => {
      if (e.reason === 'quality') {
        const i = this._findConnectionIndexById(e.target.stream.connection.id)
        this.set(`connections.${i}.videoDisabledDueToQuality`, false)
      }
    })

    subscriber.once('videoElementCreated', e => {
      /*
       * @NOTE:
       * - This check is here to unsubscribe to streams that
       *   were pending subscription after the user has hanged up
       *   the call.
       *   There are reports of streams being subscribed to after
       *   the publisher has hanged up.
       */
      if (!this.isInCall && !this.isStartingCall) {
        this.session.unsubscribe(subscriber)

        return resolve()
      }

      const subscribers = this.session.getSubscribersForStream(
        subscriber.stream
      )

      const i = this._findConnectionIndexById(stream.connection.id)

      this.set(
        `connections.${i}.streams.${stream.videoType}.srcObject`,
        e.element.srcObject
      )
      this.set(
        `connections.${i}.streams.${stream.videoType}.subscriber`,
        subscribers.length ? subscribers[0] : undefined
      )
      this.set(`connections.${i}.isConnected`, true)

      this._handleSuccess()

      resolve(stream)
    })
  })
},

_ensureIPublishOnlyOneVideoStream: function(stream) {
  if (!stream.hasVideo) return

  const i = this._findConnectionIndexById(stream.connection.id)

  if (i === -1) return

  Object.values(this.connections[i].streams)
    .filter(s => s && s.publisher && s.id !== stream.id)
    .forEach(s => s.publisher.publishVideo(false))
},
