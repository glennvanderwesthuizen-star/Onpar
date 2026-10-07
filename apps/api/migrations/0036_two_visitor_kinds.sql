-- Visitor management (owner, 7 Oct 2026): two kinds of visitor in place of five.
--   Visitor:    comes to see someone or to deliver. No time limit; who is still inside is picked
--               up at the shift handover.
--   Contractor: comes to do work on site. Should be gone by 18:00.
-- "Regular" and "fixed period" are not kinds of visitor: they are what the customer sets when
-- telling the gate who is coming. Sites that still have the five starting categories are moved
-- over; a category an administrator renamed is left alone. Nothing is deleted: past visits keep
-- the category they were recorded with, which is only taken out of use.

-- The two that stay, renamed, where the site has no category of that name already.
UPDATE visitor_categories c SET name = 'Visitor', limit_minutes = NULL, limit_until = NULL
 WHERE c.name = 'Once-off visitor'
   AND NOT EXISTS (SELECT 1 FROM visitor_categories o WHERE o.site_id = c.site_id AND lower(o.name) = 'visitor');
UPDATE visitor_categories c SET name = 'Contractor', limit_minutes = NULL, limit_until = '18:00'
 WHERE c.name = 'Contractor, once-off'
   AND NOT EXISTS (SELECT 1 FROM visitor_categories o WHERE o.site_id = c.site_id AND lower(o.name) = 'contractor');

-- Announcements made under the other three move to the one that stays.
UPDATE visitor_passes p SET category_id = keep.id
  FROM visitor_categories old, visitor_categories keep
 WHERE p.category_id = old.id AND old.name = 'Regular visitor' AND keep.site_id = old.site_id AND keep.name = 'Visitor';
UPDATE visitor_passes p SET category_id = keep.id
  FROM visitor_categories old, visitor_categories keep
 WHERE p.category_id = old.id AND old.name IN ('Regular contractor', 'Contractor, fixed period') AND keep.site_id = old.site_id AND keep.name = 'Contractor';

-- The other three are taken out of use, only where the site has the two that replace them.
UPDATE visitor_categories c SET active = false
 WHERE c.name IN ('Regular visitor', 'Regular contractor', 'Contractor, fixed period')
   AND EXISTS (SELECT 1 FROM visitor_categories k WHERE k.site_id = c.site_id AND k.name = 'Visitor' AND k.active)
   AND EXISTS (SELECT 1 FROM visitor_categories k WHERE k.site_id = c.site_id AND k.name = 'Contractor' AND k.active);
