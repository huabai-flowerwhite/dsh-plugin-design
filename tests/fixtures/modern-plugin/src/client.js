// modern-plugin client half (fixture): factory body used by the build script.
const React = require('react')

function apply(ctx) {
  const slots = ctx.get('slots')
  if (!slots) return
  slots.inject('settings.section', function () {
    return slots.register(
      { name: 'settings.section', id: 'modern-plugin', order: 200, label: 'modern plugin' },
      function () { return React.createElement('div', null, 'modern plugin') },
    )
  })
}

exports.apply = apply
exports.inject = ['slots']
