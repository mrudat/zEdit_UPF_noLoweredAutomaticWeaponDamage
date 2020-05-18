/* eslent-env node */
/* global xelib, registerPatcher, patcherUrl, info */
// ngapp is global but unused.

function formIDFromRecord (record) {
  return xelib.GetValue(record, 'Record Header\\FormID')
}

function isAutomaticWeapon (record, locals) {
  if (!xelib.IsWinningOverride(record)) {
    return false
  }

  // probably can't happen, but paranoia suggests it might.
  if (!xelib.HasElement(record, 'DATA')) {
    return false
  }

  let targetFormType = xelib.GetValue(record, 'DATA\\Form Type')
  if (targetFormType !== 'Weapon') {
    return false
  }

  // not necessary for an automatic weapon, but we key off this value, so it must be present
  if (!xelib.HasElement(record, 'MNAM - Target OMOD Keywords')) {
    return false
  }

  // TODO use sets instead?
  if (xelib.GetElements(record, 'MNAM - Target OMOD Keywords').map(keyword => xelib.GetValue(keyword)).some(formID => locals.bannedKeywordFormIDs.has(formID))) return false

  return xelib.GetElements(record, 'DATA - Data\\Properties').some(
    function (property) {
      if (xelib.GetValue(property, 'Property') !== 'Keywords') return

      if (xelib.GetValue(property, 'Value Type') !== 'FormID,Int') return

      if (xelib.GetValue(property, 'Function Type') !== 'ADD') return

      if (locals.automaticKeywordFormIDs.has(xelib.GetValue(property, 'Value 1'))) {
        return true
      }
    }
  )
}

let floatPropertyNames = [
  'MinRange',
  'MaxRange',
  'AttackDamage'
]

registerPatcher({
  info: info,
  gameModes: [xelib.gmFO4],
  settings: {
    label: 'No Lowered Automatic Weapon Damage',
    templateUrl: `${patcherUrl}/partials/settings.html`,
    defaultSettings: {
      patchHandMadeGuns: false,
      patchFileName: 'zPatch.esp'
    }
  },
  execute: (patchFile, helpers, settings, locals) => ({
    initialize: function () {
      let baseFile = xelib.FileByName('Fallout4.esm')

      let keywords = xelib.GetElement(baseFile, 'KYWD')

      locals.automaticKeywordFormIDs = new Set([
        's_30_Auto',
        'WeaponTypeAutomatic',
        'dn_HasReceiver_Automatic'
      ].map(keywordName => xelib.GetElement(keywords, keywordName)).map(formIDFromRecord))

      locals.bannedKeywordFormIDs = new Set()

      locals.bannedKeywordFormIDs.add(formIDFromRecord(xelib.GetElement(keywords, 'ma_TEMPLATE')))

      if (!settings.patchHandMadeGuns) {
        // don't patch pipe guns.
        locals.bannedKeywordFormIDs.add(formIDFromRecord(xelib.GetElement(keywords, 'ma_PipeGun')))

        let nukaWorld = xelib.FileByName('DLCNukaWorld.esm')
        if (nukaWorld) {
          locals.bannedKeywordFormIDs.add(formIDFromRecord(xelib.GetElement(nukaWorld, 'KYWD\\DLC04_ma_HandmadeAssaultRifle')))
        }
      }

      locals.offsets = {}

      helpers.loadRecords('OMOD').filter(
        record => isAutomaticWeapon(record, locals)
      ).forEach(
        function (record) {
          // only uses the first keyword, but vanilla records only have one keyword...
          let targetOMODKeywordFormID = xelib.GetValue(xelib.GetElements(record, 'MNAM - Target OMOD Keywords').shift())

          let properties = xelib.GetElements(record, 'DATA - Data\\Properties')

          if (!locals.offsets[targetOMODKeywordFormID]) {
            locals.offsets[targetOMODKeywordFormID] = {
              direct: {},
              damageType: {}
            }
          }

          let offsets = locals.offsets[targetOMODKeywordFormID]
          let directOffsets = offsets.direct
          let damageTypeOffsets = offsets.damageType

          properties.forEach(
            function (property) {
              let propertyName = xelib.GetValue(property, 'Property')

              if (floatPropertyNames.includes(propertyName)) {
                if (xelib.GetValue(property, 'Value Type') !== 'Float') return

                if (xelib.GetValue(property, 'Function Type') !== 'MUL+ADD') return

                let value = xelib.GetFloatValue(property, 'Value 1')

                if (value < 0) {
                  if (!directOffsets[propertyName]) {
                    directOffsets[propertyName] = [ -value ]
                  } else {
                    directOffsets[propertyName].push(-value)
                  }
                }
              }

              if (propertyName === 'DamageTypeValues') {
                if (xelib.GetValue(property, 'Value Type') !== 'FormID,Float') return

                let damageType = xelib.GetValue(property, 'Value 1')

                // Apparently REM with a negative value means the exact same thing as ADD with a negaitve value; no idea about SET, so not touching it.
                if (xelib.GetValue(property, 'Function Type') === 'SET') return

                let value = xelib.GetFloatValue(property, 'Value 2')

                if (value < 0) {
                  if (!damageTypeOffsets[damageType]) {
                    damageTypeOffsets[damageType] = [ -value ]
                  } else {
                    damageTypeOffsets[damageType].push(-value)
                  }
                }
              }
            }
          )
        }
      )

      console.log(locals.offsets)

      Object.entries(locals.offsets).forEach(
        function ([targetOMODKeywordFormID, offsetsForTarget]) {
          let keepOffsetsForTarget = false
          Object.entries(offsetsForTarget).forEach(
            function ([propertyType, offsetsForTargetAndType]) {
              let keepOffsetsForTargetAndType = false
              Object.entries(offsetsForTargetAndType).forEach(
                function ([propertyName, value]) {
                  keepOffsetsForTarget = true
                  keepOffsetsForTargetAndType = true
                  offsetsForTargetAndType[propertyName] = Math.max(...value)
                }
              )
              if (!keepOffsetsForTargetAndType) {
                delete offsetsForTarget[propertyType]
              }
            }
          )
          if (!keepOffsetsForTarget) {
            delete locals.offsets[targetOMODKeywordFormID]
          }
        }
      )

      console.log(locals.offsets)

      Object.entries(locals.offsets).forEach(
        function ([targetOMODKeywordFormID, offsetsForTarget]) {
          helpers.logMessage(`Worst penalties for for ${targetOMODKeywordFormID}:`)
          Object.entries(offsetsForTarget).forEach(
            function ([propertyType, offsetsForTargetAndType]) {
              helpers.logMessage(`  ${propertyType}:`)
              Object.entries(offsetsForTargetAndType).forEach(
                function ([propertyName, value]) {
                  let prettyValue = value.toPercentage()
                  helpers.logMessage(`    ${propertyName} = ${prettyValue}`)
                }
              )
            }
          )
        }
      )
    },
    process: [
      {
        load: {
          signature: 'OMOD',
          filter: record => isAutomaticWeapon(record, locals)
        },
        patch: function (record) {
          let properties = xelib.GetElements(record, 'DATA - Data\\Properties')

          let targetOMODKeywordFormIDs = xelib.GetElements(record, 'MNAM - Target OMOD Keywords').map(keyword => xelib.GetValue(keyword))

          let offsetsForKeyword // worst penalty for any automatic reciever.

          targetOMODKeywordFormIDs.forEach(
            function (targetOMODKeywordFormID) {
              offsetsForKeyword = locals.offsets[targetOMODKeywordFormID]
            }
          )

          if (!offsetsForKeyword) {
            helpers.logMessage(`No need to patch ${xelib.LongName(record)}`)
            return
          }

          helpers.logMessage(`Patching ${xelib.LongName(record)}`)

          let directOffsets = offsetsForKeyword.direct

          for (let propertyName in directOffsets) {
            let value = directOffsets[propertyName]
            let theProperty = properties.filter(
              function (property) {
                if (xelib.GetValue(property, 'Property') !== propertyName) return
                if (xelib.GetValue(property, 'Value Type') !== 'Float') return
                if (xelib.GetValue(property, 'Function Type') !== 'MUL+ADD') return
                return true
              }
            )
            let property
            let oldValue
            if (theProperty.length) {
              property = theProperty[0]
              oldValue = xelib.GetFloatValue(property, 'Value 1')
            } else {
              property = xelib.AddArrayItem(record, 'DATA - Data\\Properties', '', '')
              xelib.SetValue(property, 'Value Type', 'Float')
              xelib.SetValue(property, 'Function Type', 'MUL+ADD')
              xelib.SetValue(property, 'Property', propertyName)
              oldValue = 0
            }
            let newValue = oldValue + value
            let prettyValue = value.toPercentage()
            let prettyOldValue = oldValue.toPercentage()
            let prettyNewValue = newValue.toPercentage()
            helpers.logMessage(`Increasing ${propertyName} by ${prettyValue} from ${prettyOldValue} to ${prettyNewValue}`)
            xelib.SetFloatValue(property, 'Value 1', newValue)
          }

          let damageTypeOffsets = offsetsForKeyword.damageType

          for (let damageType in damageTypeOffsets) {
            let value = damageTypeOffsets[damageType]
            let theProperty = properties.filter(
              function (property) {
                if (xelib.GetValue(property, 'Property') !== 'DamageTypeValues') return
                if (xelib.GetValue(property, 'Value Type') !== 'FormID,Float') return
                if (xelib.GetValue(property, 'Function Type') === 'SET') return
                if (xelib.GetValue(property, 'Value 1') !== damageType) return
                return true
              }
            )
            let property
            let oldValue
            if (theProperty.length) {
              property = theProperty[0]
              oldValue = xelib.GetFloatValue(property, 'Value 2')
            } else {
              property = xelib.AddArrayItem(record, 'DATA - Data\\Properties', '', '')
              xelib.SetValue(property, 'Property', 'DamageTypeValues')
              xelib.SetValue(property, 'Value Type', 'FormID,Float')
              oldValue = 0
            }
            xelib.SetValue(property, 'Function Type', 'ADD')
            let newValue = oldValue + value
            let prettyValue = value.toPercentage()
            let prettyOldValue = oldValue.toPercentage()
            let prettyNewValue = newValue.toPercentage()
            helpers.logMessage(`Increasing ${damageType} by ${prettyValue} from ${prettyOldValue} to ${prettyNewValue}`)
            xelib.SetFloatValue(property, 'Value 2', newValue)
          }

          // remove properties that ADD zero to a value
          properties = xelib.GetElements(record, 'DATA - Data\\Properties')

          for (let i = properties.length - 1; i >= 0; i--) {
            let property = properties[i]

            let deleteThis = false

            switch (xelib.GetValue(property, 'Value Type')) {
              case 'Float':
                if (xelib.GetValue(property, 'Function Type') === 'MUL+ADD') {
                  if (xelib.GetFloatValue(property, 'Value 1') === 0.0 && xelib.GetFloatValue(property, 'Value 2') === 0.0) {
                    deleteThis = true
                  }
                }
                if (xelib.GetValue(property, 'Function Type') === 'ADD') {
                  if (xelib.GetFloatValue(property, 'Value 1') === 0.0) {
                    deleteThis = true
                  }
                }
                break
              case 'FormID,Float':
                if (xelib.GetValue(property, 'Function Type') !== 'SET') {
                  if (xelib.GetValue(property, 'Property') === 'DamageTypeValues') {
                    if (xelib.GetFloatValue(property, 'Value 2') === 0.0) {
                      deleteThis = true
                    }
                  }
                }
                break
            }

            if (deleteThis) {
              xelib.RemoveElement(property)
            }
          }
        }
      }
    ]
  })
})
