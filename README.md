# ot-safari-14-video-crash

Demo of Vonage OpentokJS crash on Safari 14.

## Steps to reproduce:

- Serve this page locally on `http://0.0.0.0:8000`
- Visit, using Safari 14, `http://0.0.0.0:8000`.
- Open another tab and visit `http://0.0.0.0:8000` again.

## Expected Result:

- Both tabs can see their video and the other participant video. In short
  they can see each other.

## Actual Result

- As soon as the 2nd tab joins the session, the 1st tabs video stops. There
  is no way for both participants to see each other.
