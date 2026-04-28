const { ApolloClient, InMemoryCache, gql, HttpLink } = require('@apollo/client/core');
const fetch = require('cross-fetch');

const client = new ApolloClient({
  link: new HttpLink({ uri: 'https://www.news.cbnyellowsingam.in/graphql', fetch }),
  cache: new InMemoryCache()
});

client.query({
  query: gql`{ news(limit: 1) { title } }`
}).then(res => console.log(res.data.news[0].title))
.catch(err => console.error(err));
