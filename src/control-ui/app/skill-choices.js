'use strict';
// The skill checkboxes of the task, agent and schedule forms.
function skillChoices(selected=[],name='skillIds') {
  return state.skills.length ? `<div class="skill-choices">${state.skills.map(skill=>`<label class="skill-choice"><input type="checkbox" name="${name}" value="${esc(skill.id)}" ${selected.includes(skill.id)?'checked':''}><span><strong>${esc(skill.name)}</strong><small>${esc(skill.description||globalThis.AIWSI18n.template`${skill.files.length} destek dosyası`)}</small></span></label>`).join('')}</div>` : globalThis.AIWSI18n.text('<p class="field-info">Henüz skill yok. Skiller ekranından SKILL.md yükleyebilir veya kendi skillini oluşturabilirsin.</p>');
}
