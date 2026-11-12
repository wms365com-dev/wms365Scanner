begin;

alter table portal_order_print_events
    drop constraint if exists portal_order_print_events_document_type_check;

alter table portal_order_print_events
    add constraint portal_order_print_events_document_type_check
    check (document_type in ('PICK_TICKET', 'PACKING_SLIP', 'UCC128_LABELS', 'BILL_OF_LADING'));

commit;
