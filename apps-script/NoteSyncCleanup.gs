// One-time cleanup for the retired VAN_INFO Notes/Reason synchronization.
// This does NOT touch Spot, Status, Bag, inspections, damage records, or VAN_INFO data.

function removeVanInfoNoteSyncCompletely(){
  const retiredHandlers=[
    'syncVanInfoReasonsBidirectional',
    'syncDamageReasonsToVanInfo'
  ];

  let removedTriggers=0;
  ScriptApp.getProjectTriggers().forEach(trigger=>{
    if(retiredHandlers.includes(trigger.getHandlerFunction())){
      ScriptApp.deleteTrigger(trigger);
      removedTriggers++;
    }
  });

  const props=PropertiesService.getScriptProperties();
  props.deleteProperty('VAN_INFO_REASON_BRIDGE_V1');

  return {
    ok:true,
    removedTriggers:removedTriggers,
    removedSnapshot:'VAN_INFO_REASON_BRIDGE_V1'
  };
}
