-- Read-only operator template; rehearsed only against disposable synthetic data.
-- psql -X 'service=velora-prod-review' -v ON_ERROR_STOP=1
--   -v candidate=<64-hex-key> -v reviewer=<approved-user-uuid> -f this-file
select current_database(), current_user, session_user;
select current_user = 'velora_review_service' and session_user = 'velora_review_service' as correct_identity \gset
\if :correct_identity
\else
  \quit 3
\endif
select catalogue_review.inspect_channel_candidate(:'candidate') as candidate;
select catalogue_review.inspect_channel_candidate(:'candidate')->'rights' as rights;
select catalogue_review.inspect_channel_candidate(:'candidate')->'evidence' as readiness;
select catalogue_review.reviewer_capabilities(:'reviewer'::uuid) as capability;
select catalogue_review.inspect_channel_candidate(:'candidate')->'publication' as publication;
