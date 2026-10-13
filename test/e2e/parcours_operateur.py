# Parcours opérateur complet dans un vrai navigateur (Playwright Python).
# Usage : npm start (dans un autre terminal), puis : python3 test/e2e/parcours_operateur.py [dossier_captures] [url]
import re, sys, datetime
from playwright.sync_api import sync_playwright
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
URL = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:4173/'
errors = []
def check(cond, msg):
    print(('OK   ' if cond else 'FAIL ') + msg)
    if not cond: errors.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 800, 'height': 1280}, timezone_id='Europe/Paris', locale='fr-FR', accept_downloads=True, service_workers='block')
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('JS: ' + str(e)))
    page.clock.install(time=datetime.datetime.fromisoformat('2025-01-01T14:30:00+01:00'))
    page.goto(URL)
    page.wait_for_selector('.line-card')
    check(page.locator('.shift-option.selected').inner_text().startswith('Après-midi'), 'poste suggéré = Après-midi à 14:30')
    check(page.locator('#shift-warning').is_hidden(), 'pas d’alerte de poste')
    page.screenshot(path=f'{OUT}/01_accueil.png', full_page=True)

    page.click('[data-group="A2"]')
    check('À configurer' in page.locator('.line-card').first.inner_text(), 'L8 : à configurer (aucune valeur inventée)')
    check('3000 m' not in page.locator('#line-list').inner_text(), 'aucun 3000 m inventé')
    page.screenshot(path=f'{OUT}/02_groupe_A2.png', full_page=True)
    page.click('[data-group="A1"]')

    l4 = page.locator('.line-card', has_text='L4')
    l4.locator('.start-now-button').click()
    check('opérateur' in page.locator('#toast').inner_text(), 'démarrage refusé sans n° opérateur')
    check('À démarrer' in l4.inner_text(), 'L4 toujours à démarrer')

    op = page.locator('#operator-number')
    op.click(); op.type('10')
    page.clock.run_for(11_000)
    check(op.input_value() == '10', 'saisie opérateur non écrasée pendant le rafraîchissement')
    op.type('73'); op.press('Enter')

    # configurer OF sur L4
    l4.locator('.line-name').click()
    page.wait_for_selector('#line-dialog[open]')
    f = page.locator('#line-form')
    f.locator('[name=ofNumber]').fill('OF555')
    f.locator('[data-cap="12"]').click()
    f.locator('[name=lastCoil]').fill('10')
    f.locator('button[value=save]').click()
    l4.locator('.start-now-button').click()
    check('Bob. 10' in l4.inner_text() and 'Pal. 1 : 10/12' in l4.inner_text(), 'L4 démarré, reprise après bobine 10, palette 1 10/12')
    check('Dernier cycle du poste' in l4.inner_text(), 'marge de fin de poste affichée')
    page.screenshot(path=f'{OUT}/03_L4_demarre.png', full_page=True)

    page.clock.run_for(54 * 60_000)
    page.wait_for_timeout(200)
    check('Cycle à valider' in l4.inner_text(), 'cycle terminé signalé à valider')
    page.screenshot(path=f'{OUT}/04_cycle_a_valider.png', full_page=True)

    l4.locator('.line-name').click()
    page.wait_for_selector('#detail-dialog[open]')
    page.screenshot(path=f'{OUT}/05_detail_L4.png', full_page=True)
    page.click('[data-action="complete"]')
    page.wait_for_selector('#pallet-dialog[open]')
    check('PALETTE 1 COMPLÈTE' in page.locator('#pallet-title').inner_text(), 'palette 1 complète déclenchée à la bobine 12')
    check('11' not in page.locator('#pallet-info').inner_text() or '1 → 12' in page.locator('#pallet-info').inner_text(), 'plage palette 1 → 12')
    pad = page.locator('#pallet-form .numeric-pad')
    for k in ['5','1','2',',','5']: pad.locator(f'button:text-is("{k}")').click()
    page.screenshot(path=f'{OUT}/06_palette.png')
    page.locator('#pallet-form button[value=save]').click()
    page.wait_for_selector('#detail-dialog[open]')
    check('n° 12' in page.locator('#detail-content').inner_text(), 'dernière bobine validée = 12')
    check('Palette en cours' in page.locator('#detail-content').inner_text() and 'n° 2 : 0/12' in page.locator('#detail-content').inner_text(), 'palette 2 : 0/12')

    # double appui
    page.once('dialog', lambda d: d.dismiss())
    page.click('[data-action="complete"]')
    page.wait_for_timeout(200)
    st = page.evaluate("JSON.parse(localStorage.getItem('application-bobines-v1'))")
    l4s = [l for l in st['lines'] if l['lineNumber']==4][0]
    check(l4s['production']['lastCoil'] == 12, 'double appui refusé : pas de bobine en double')
    check(l4s['production']['pallets'][0]['grossKg'] == 512.5, 'poids brut 512,5 kg enregistré')

    # arrêt / reprise
    l4.locator('.line-name').click()
    page.click('[data-action="pause"]')
    page.wait_for_selector('#event-dialog[open]')
    page.select_option('#event-form [name=reason]', 'Réglage')
    page.locator('#event-form button[value=save]').click()
    page.wait_for_selector('#detail-dialog[open]')
    check(page.locator('[data-action="complete"]').is_disabled(), 'validation de cycle bloquée pendant l’arrêt')
    page.keyboard.press('Escape')
    check('En arrêt' in l4.inner_text(), 'carte en arrêt')
    page.clock.run_for(15 * 60_000)
    l4.locator('.line-name').click()
    page.click('[data-action="resume"]')
    page.locator('#event-form button[value=save]').click()
    page.wait_for_selector('#detail-dialog[open]')
    page.click('[data-action="waste"]')
    page.click('[data-code="D2"]')
    for k in ['3',',','2']: page.locator('#waste-form .numeric-pad').locator(f'button:text-is("{k}")').click()
    page.locator('#waste-form button[value=save]').click()
    l4.locator('.line-name').click()
    page.click('[data-action="anomaly"]')
    page.click('[data-category="Bobine à déclasser"]')
    page.fill('#anomaly-form [name=note]', 'bobine 11')
    page.locator('#anomaly-form button[value=save]').click()

    page.click('#summary-button')
    page.wait_for_selector('#summary-dialog[open]')
    txt = page.locator('#summary-content').inner_text()
    check('2\nbobines validées' in txt or re.search(r'2\s*bobines validées', txt), 'bilan : 2 bobines')
    check('3,2 kg' in txt, 'bilan : 3,2 kg de déchets')
    check('Réglage' in txt, 'bilan : motif d’arrêt Réglage')
    check('prochaine 13' in txt, 'passation : prochaine bobine 13')
    page.screenshot(path=f'{OUT}/07_bilan.png', full_page=True)
    with page.expect_download() as dl:
        page.click('[data-export="shift"]')
    path = dl.value.path(); csv = open(path, encoding='utf-8-sig').read()
    check('Cycle terminé;Bobines 11–12' in csv and 'Palette complète' in csv and 'Poids palette' in csv, 'export CSV complet')
    open(f'{OUT}/export_poste.csv','w').write(csv)
    page.keyboard.press('Escape')

    # rechargement
    page.reload(); page.wait_for_selector('.line-card')
    l4 = page.locator('.line-card', has_text='L4')
    check('Bob. 12' in l4.inner_text(), 'état conservé après rechargement')
    check(page.locator('#operator-number').input_value() == '1073', 'opérateur conservé pour le poste')

    # annulation
    l4.locator('.line-name').click()
    page.once('dialog', lambda d: d.accept())
    page.click('[data-action="undo"]')
    page.wait_for_selector('#detail-dialog[open]')
    check('n° 10' in page.locator('#detail-content').inner_text(), 'annulation : retour à la bobine 10')
    page.keyboard.press('Escape')

    # fin de poste -> carte poste terminé ; nouvelle équipe nuit reprend
    page.clock.run_for(8 * 3600_000)
    page.wait_for_timeout(300)
    check(page.locator('#shift-warning').is_visible(), 'alerte : poste sélectionné terminé')
    page.screenshot(path=f'{OUT}/08_fin_poste.png', full_page=True)
    page.click('#shift-warning [data-shift]')
    check(page.locator('.shift-option.selected').inner_text().startswith('Nuit'), 'passage au poste de nuit')
    check(page.locator('#operator-number').input_value() == '', 'nouvel opérateur vide pour le nouveau poste')
    l4 = page.locator('.line-card', has_text='L4')
    check('Bob. 10' in l4.inner_text(), 'continuité : la nuit voit la dernière bobine 10')

    # mobile
    m = ctx.new_page(); m.set_viewport_size({'width': 390, 'height': 844})
    m.clock.install(time=datetime.datetime.fromisoformat('2025-01-01T23:00:00+01:00'))
    m.goto(URL); m.wait_for_selector('.line-card')
    sw = m.evaluate('document.documentElement.scrollWidth')
    check(sw <= 390, f'mobile sans défilement horizontal ({sw}px)')
    m.screenshot(path=f'{OUT}/09_mobile.png', full_page=True)
    b.close()
print('\nERREURS:', errors if errors else 'aucune')
