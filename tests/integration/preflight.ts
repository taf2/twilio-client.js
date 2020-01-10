import Device from '../../lib/twilio/device';
import Preflight from '../../lib/twilio/preflight';
import { generateAccessToken } from '../lib/token';
import * as assert from 'assert';
import { EventEmitter } from 'events';
import PreflightTest from '../../lib/twilio/preflight';
import Connection from '../../lib/twilio/connection';

const DURATION_PADDING = 1000;
const EVENT_TIMEOUT = 20000;
const MAX_TIMEOUT = 300000;

describe('Preflight Test', function() {
  this.timeout(MAX_TIMEOUT);

  let callerIdentity: string;
  let callerToken: string;
  let callerDevice: Device;
  let callerConnection: Connection;
  let receiverIdentity: string;
  let receiverDevice: Device;
  let preflight: Preflight;

  const expectEvent = (eventName: string, emitter: EventEmitter) => {
    return new Promise((resolve) => emitter.once(eventName, (res) => resolve(res)));
  };

  const waitFor = (promiseOrArray: Promise<any> | Promise<any>[], timeoutMS: number) => {
    let timer: NodeJS.Timer;
    const promise = Array.isArray(promiseOrArray) ? Promise.all(promiseOrArray) : promiseOrArray;
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out`)), timeoutMS);
    });

    return Promise.race([promise, timeoutPromise]).then(() => clearTimeout(timer));
  };

  const setupDevices = () => {
    receiverIdentity = 'id1-' + Date.now();
    callerIdentity = 'id2-' + Date.now();
    
    const receiverToken = generateAccessToken(receiverIdentity);
    callerToken = generateAccessToken(callerIdentity);
    receiverDevice = new Device();

    return expectEvent('ready', receiverDevice.setup(receiverToken, { debug: false }));
  };

  const destroyReceiver = () => {
    if (receiverDevice) {
      receiverDevice.disconnectAll();
      receiverDevice.destroy();
    }
  };

  describe('when test finishes', function() {
    before(async () => {
      await setupDevices();
      receiverDevice.on('incoming', conn => {
        conn.accept();
      });
      preflight = Device.testPreflight(callerToken, { connectParams: { To: receiverIdentity }});
      callerDevice = preflight['_device'];
    });

    after(() => {
      destroyReceiver();
    });

    it('should set status to connecting', () => {
      assert.equal(preflight.status, PreflightTest.TestStatus.Connecting);
    });

    it('should emit non-fatal error', () => {
      setTimeout(() => {
        callerDevice.emit('error', { code: 31400 });
      }, 5);

      return waitFor(expectEvent('error', preflight).then(error => {
        assert.equal(error, PreflightTest.NonFatalError.InsightsConnectionFailed);
      }), EVENT_TIMEOUT);
    });

    it('should emit connected event', () => {
      return waitFor(expectEvent('connected', preflight).then(() => {
        callerConnection = preflight['_connection'];
      }), EVENT_TIMEOUT);
    });

    it('should set status to connected', () => {
      assert.equal(preflight.status, PreflightTest.TestStatus.Connected);
    });

    it('should set default codePreferences', () => {
      assert.deepEqual(callerDevice['options'].codecPreferences, [Connection.Codec.PCMU, Connection.Codec.Opus]);
    });

    it('should emit warning event', () => {
      const name = 'constant-audio-input-level';
      setTimeout(() => {
        callerConnection.emit('warning', name, {});
      }, 5);

      return waitFor(expectEvent('warning', preflight).then(warning => {
        assert.equal(warning, name);
      }), EVENT_TIMEOUT);
    });

    it('should emit sample event', () => {
      return waitFor(expectEvent('sample', preflight), EVENT_TIMEOUT);
    });

    it('should emit completed event', () => {
      return waitFor(expectEvent('completed', preflight).then((results: PreflightTest.TestResults) => {
        assert(!!results);
        assert(!!results.averageSample);
        assert(!!results.samples.length);
        assert(!!results.errors.length);
        assert(!!results.warnings.length);
        assert.deepEqual(results, preflight.results);
      }), EVENT_TIMEOUT);
    });

    it('should set status to completed', () => {
      assert.equal(preflight.status, PreflightTest.TestStatus.Completed);
    });

    it('should set call duration to 15s by default', () => {
      const delta = preflight.endTime! - preflight.startTime;
      const duration = 15000;
      assert(delta >= duration && delta <= duration + DURATION_PADDING);
    });
  });

  describe('when using non-default options', () => {
    before(async () => {
      await setupDevices();
      receiverDevice.on('incoming', conn => {
        conn.accept();
      });
      preflight = Device.testPreflight(callerToken, {
        callSeconds: 5,
        codecPreferences: [Connection.Codec.PCMU],
        connectParams: { To: receiverIdentity }
      });
      callerDevice = preflight['_device'];
    });

    after(() => {
      destroyReceiver();
    });

    it('should use codePreferences passed in', () => {
      assert.deepEqual(callerDevice['options'].codecPreferences, [Connection.Codec.PCMU]);
    });

    it('should finish test using custom call duration', () => {
      return waitFor(expectEvent('completed', preflight).then(() => {
        const delta = preflight.endTime! - preflight.startTime;
        const duration = 5000;
        assert(delta >= duration && delta <= duration + DURATION_PADDING);
      }), EVENT_TIMEOUT);
    });
  });

  describe('when test is cancelled', function() {
    const FAIL_DELAY = 1000;
    before(async () => {
      await setupDevices();
      receiverDevice.on('incoming', conn => {
        conn.accept();
      });
      preflight = Device.testPreflight(callerToken, { connectParams: { To: receiverIdentity }});
      callerDevice = preflight['_device'];
    });

    after(() => {
      destroyReceiver();
    });

    it('should emit connected event', () => {
      return waitFor(expectEvent('connected', preflight), EVENT_TIMEOUT);
    });

    it('should emit failed event on cancelled', () => {
      setTimeout(() => {
        preflight.cancel();
      }, FAIL_DELAY);
      return waitFor(expectEvent('failed', preflight).then(error => {
        assert.equal(error, PreflightTest.FatalError.CallCancelled);
      }), EVENT_TIMEOUT);
    });

    it('should populate call duration correctly', () => {
      const delta = preflight.endTime! - preflight.startTime;
      assert(delta >= FAIL_DELAY && delta <= FAIL_DELAY + DURATION_PADDING);
    });
  });

  describe('when fatal error happens', function() {
    const FAIL_DELAY = 500;
    [{
      code: 31000,
      name: PreflightTest.FatalError.SignalingConnectionFailed
    },{
      code: 31003,
      name: PreflightTest.FatalError.IceConnectionFailed
    },{
      code: 20101,
      name: PreflightTest.FatalError.InvalidToken
    },{
      code: 31208,
      name: PreflightTest.FatalError.MediaPermissionsFailed
    },{
      code: 31201,
      name: PreflightTest.FatalError.NoDevicesFound
    }].forEach(error => {
      describe(`code: ${error.code}`, () => {
        before(async () => {
          await setupDevices();
          receiverDevice.on('incoming', conn => {
            conn.accept();
          });
          preflight = Device.testPreflight(callerToken, { connectParams: { To: receiverIdentity }});
          callerDevice = preflight['_device'];
        });
    
        after(() => {
          destroyReceiver();
        });
    
        it('should emit connected event', () => {
          return waitFor(expectEvent('connected', preflight), EVENT_TIMEOUT);
        });
    
        it('should emit failed event on fatal error', () => {
          setTimeout(() => {
            callerDevice.emit('error', { code: error.code });
          }, FAIL_DELAY);
          return waitFor(expectEvent('failed', preflight).then(name => {
            assert.equal(name, PreflightTest.FatalError[error.name]);
          }), EVENT_TIMEOUT);
        });
    
        it('should populate call duration correctly', () => {
          const delta = preflight.endTime! - preflight.startTime;
          assert(delta >= FAIL_DELAY && delta <= FAIL_DELAY + DURATION_PADDING);
        });
      });
    });
  });
});
