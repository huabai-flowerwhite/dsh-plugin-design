// Generated from src/client.js - do not edit by hand.
window.__ModuleLoader__.load({
  id: "dshpd-demo-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // Client half source (factory body). scripts/build-client.mjs wraps this into
    // the lazy-CJS bundle loaded by the harness.
    const React = require('react')

    const VERSION = '1.0.0'

    function Panel() {
      const state = React.useState(null)
      const status = state[0]
      const setStatus = state[1]
      React.useEffect(function () {
        let alive = true
        fetch('/dshpd-demo/health').then(function (response) { return response.json() }).then(function (data) {
          if (alive) setStatus(data)
        }).catch(function (error) {
          if (alive) setStatus({ ok: false, error: String(error) })
        })
        return function () { alive = false }
      }, [])
      return React.createElement('div', { style: { padding: 8 } }, [
        React.createElement('h3', { key: 'title' }, 'Demo plugin ' + VERSION),
        React.createElement('div', { key: 'status' }, status === null ? 'checking...' : String(status.ok)),
      ])
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function') return
      slots.inject('settings.section', function () {
        return slots.register({ name: 'settings.section', id: 'dshpd-demo-plugin', label: 'Demo plugin' }, Panel)
      })
    }

    exports.apply = apply
    exports.inject = ['slots']

    return module.exports;
  },
});
