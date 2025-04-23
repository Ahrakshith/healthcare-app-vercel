export default async function handler(req, res) {
  console.log('Function loaded and handler invoked at', new Date().toISOString(), {
    method: req.method,
    query: req.query,
  });
  return res.status(200).json({ message: 'Hello from serverless function!' });
}